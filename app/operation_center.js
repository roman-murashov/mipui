const MAX_STORED_OPERATIONS = 100;

// This class is responsible for synchronizing operations between clients, and
// for managing the undo stack.
class OperationCenter {
  constructor() {
    // Current-operation-related fields.
    this.currentOperation_ = new Operation();
    this.autoSaveTimerId_ = null;

    // Synchronization-related fields.

    // All operations performed locally that have not yet been sent to and
    // accepted by the database.
    this.pendingLocalOperations_ = [];
    // True if local pending operations are currently being sent to the
    // database, or re-applied for incoming operations.
    this.isCurrentlyProcessingPendingOperations_ = false;
    // The last-operation num for the fullMap stored in the database.
    this.lastFullMapNum_ = 0;

    // Undo-related fields.

    // All operations that have been performed on the state since the last
    // state load (or creation). Some may not yet be accepted.
    // * Once the size of this objects exceeds MAX_STORED_OPERATIONS,
    //   newly-added operations will wipe old operations.
    this.appliedOperations_ = [];
    // The index of the latest applied operation in this.appliedOperations_.
    // May be different from this.appliedOperations_.length-1 when operations
    // are undoed.
    // * This is independent between clients.
    this.latestAppliedOperationIndex_ = -1;
  }

  recordCellChange(key, layer, oldContent, newContent) {
    this.currentOperation_.addCellChange(key, layer, oldContent, newContent);
    this.recordChange_();
  }

  recordGridDataChange(property, oldContent, newContent) {
    this.currentOperation_.addGridDataChange(property, oldContent, newContent);
    this.recordChange_();
  }

  undo() {
    this.recordOperationComplete();
    const op = this.appliedOperations_[this.latestAppliedOperationIndex_];
    if (!op) return;
    this.latestAppliedOperationIndex_--;
    op.undo();
    this.pendingLocalOperations_.push(op.reverse());
    this.startSendingPendingLocalOperations_();
  }

  redo() {
    this.recordOperationComplete();
    const op = this.appliedOperations_[this.latestAppliedOperationIndex_ + 1];
    if (!op) return;
    this.latestAppliedOperationIndex_++;
    op.redo();
    this.pendingLocalOperations_.push(op);
    this.startSendingPendingLocalOperations_();
  }

  startListeningForMap() {
    if (!state.getMid()) return;
    const mapPath = `/maps/${state.getMid()}/payload/fullMap`;
    firebase.database().ref(mapPath).on('value', fullMapRef => {
      if (!fullMapRef) return;
      const fullMap = fullMapRef.val();
      if (!fullMap) return;
      // Check if our map is the same (or newer!)
      if (fullMap.lastOpNum <= state.getLastOpNum()) return;
      setStatus(Status.UPDATING);
      state.load(fullMap);
      this.lastFullMapNum_ = fullMap.lastOpNum;
      setStatus(Status.READY);
    });
  }

  startListeningForOperations() {
    if (!state.getMid()) return;
    const latestOperationNumPath =
        `/maps/${state.getMid()}/payload/latestOperation/n`;
    firebase.database().ref(latestOperationNumPath).on('value', numRef => {
      if (!numRef) return;
      const num = numRef.val();
      if (num === null) return;
      setStatus(Status.UPDATING);
      if (num < state.getLastOpNum()) {
        // This should never happen. Just skip this update.
        setStatus(Status.UPDATE_ERROR);
      } else if (num == state.getLastOpNum()) {
        // This is caused by our own sendOp_(), so do nothing.
      } else {
        const fromNum = state.getLastOpNum() + 1;
        state.setLastOpNum(num);
        this.loadAndPerformAndAddOperations_(fromNum, num);
      }
    });
  }

  recordOperationComplete() {
    if (this.currentOperation_.length == 0) return;
    this.addLocalOperation_(this.currentOperation_);
    this.currentOperation_ = new Operation();
    if (this.autoSaveTimerId_) {
      clearTimeout(this.autoSaveTimerId_);
      this.autoSaveTimerId_ = null;
    }
  }

  recordChange_() {
    if (this.autoSaveTimerId_) {
      clearTimeout(this.autoSaveTimerId_);
    }
    this.autoSaveTimerId_ = setTimeout(() => {
      this.autoSaveTimerId_ = null;
      this.recordOperationComplete();
    }, 5000);
  }

  loadAndPerformAndAddOperations_(fromNum, toNum) {
    if (fromNum > toNum) {
      // We're done getting changes from the database; now apply pending
      // changes.
      setStatus(Status.READY);
      this.startSendingPendingLocalOperations_();
      return;
    }
    const path = `/maps/${state.getMid()}/payload/operations/${fromNum}`;
    firebase.database().ref(path).on('value', opDataRef => {
      if (!opDataRef) return;
      const opData = opDataRef.val();
      if (!opData) return;
      // The data is ready! Stop listening.
      firebase.database().ref(path).off('value');
      // And read it.
      const op = new Operation(opData);
      this.addRemoteOperation_(op);
      this.loadAndPerformAndAddOperations_(fromNum + 1, toNum);
    });
  }

  // Adds a new local operation. Expected to be called immediately after that
  // operation was performed on the state. The operation is assumed to not yet
  // be accepted.
  addLocalOperation_(op) {
    this.addOperation_(op);
    this.pendingLocalOperations_.push(op);
    this.startSendingPendingLocalOperations_();
  }

  addRemoteOperation_(op) {
    // First, stop the current operation.
    this.recordOperationComplete();
    // A remote operation is ready and loaded. Since it's remote, it hasn't
    // been locally applied yet nor added to the undo stack, but since it may
    // invalidate pending operations, we temporarily undo and then try to
    // re-apply them.
    this.stopSendingPendingLocalOperations_();
    this.undoPendingOperations_();
    this.addOperation_(op);
    op.redo();
    this.redoPendingOperations_();
  }

  undoPendingOperations_() {
    for (let i = this.pendingLocalOperations_.length - 1; i >= 0; i--) {
      this.pendingLocalOperations_[i].undo();
    }
  }

  redoPendingOperations_() {
    const newPendingLocalOperations = [];
    for (let i = 0; i < this.pendingLocalOperations_.length; i++) {
      const op = this.pendingLocalOperations_[i];
      if (op.isLegalToRedo()) {
        op.redo();
        newPendingLocalOperations.push(op);
      } else {
        // Don't add conflicting operations back to newPendingLocalOperations.
      }
    }
    this.pendingLocalOperations_ = newPendingLocalOperations;
  }

  // Add an operation to the applied operation array.
  addOperation_(op) {
    if (op.length == 0) {
      return;
    }

    this.appliedOperations_ =
        this.appliedOperations_
            .slice(0, this.latestAppliedOperationIndex_ + 1)
                .concat(op);
    this.latestAppliedOperationIndex_ = this.appliedOperations_.length - 1;
    if (this.appliedOperations_.length > MAX_STORED_OPERATIONS) {
      this.appliedOperations_.shift;
      this.latestAppliedOperationIndex_--;
    }
  }

  startSendingPendingLocalOperations_() {
    if (this.pendingLocalOperations_.length == 0) {
      this.stopSendingPendingLocalOperations_();
      return;
    }
    if (this.isCurrentlyProcessingPendingOperations_) {
      return;
    }
    return this.sendPendingLocalOperations_();
  }

  continueSendingPendingLocalOperations_() {
    if (this.pendingLocalOperations_.length == 0) {
      this.stopSendingPendingLocalOperations_();
      setStatus(Status.SAVED);
      return;
    }
    if (!this.isCurrentlyProcessingPendingOperations_) {
      return;
    }
    return this.sendPendingLocalOperations_();
  }

  sendPendingLocalOperations_() {
    this.isCurrentlyProcessingPendingOperations_ = true;
    setStatus(Status.SAVING);
    this.sendOp_(this.pendingLocalOperations_[0]);
  }

  stopSendingPendingLocalOperations_() {
    this.isCurrentlyProcessingPendingOperations_ = false;
  }

  sendOp_(op, onSuccess, onFailure, onError) {
    if (!state.getMid()) {
      state.setupNewMid();
      this.startListeningForMap();
      this.startListeningForOperations();
    }
    op.num = state.getLastOpNum() + 1;
    const latestOperationPath =
        `/maps/${state.getMid()}/payload/latestOperation`;
    firebase.database().ref(latestOperationPath).transaction(currData => {
      // This condition enforces the linear constraint on operations.
      if (!currData || currData.n + 1 == op.num) {
        state.setLastOpNum(op.num);
        return op.data;
      }
    }, (error, committed, snapshot) => {
      if (error) {
        this.handleOperationSendError_(op, error);
      } else if (!committed) {
        this.handleOperationSendFailure_(op);
      } else {
        this.handleOperationSendSuccess_(op);
      }
    }, false /* suppress updates on intermediate states */);
  }

  handleOperationSendSuccess_(op) {
    this.pendingLocalOperations_.shift();
    // state.setLastOpNum(op.num);
    // Immediately try updating with the next pending operation (if any).
    this.continueSendingPendingLocalOperations_();
    // And concurrently, actually write the operation in its place.
    const opPath = `/maps/${state.getMid()}/payload/operations/${op.num}`;
    firebase.database().ref(opPath).set(op.data, error => {
      this.rewriteIfRequired_();
    });
  }

  handleOperationSendFailure_(op) {
    // Failure means that other operations were executed concurrently remotely
    // and were accepted before op. So we have to wait until all remote
    // operations are applied, then retry.
    this.stopSendingPendingLocalOperations_();
  }

  handleOperationSendError_(op, err) {
    // Not much to do here. Just hope that by the next time we send an
    // operation, the problem will be resolved.
    setStatus(Status.SAVE_ERROR);
    this.stopSendingPendingLocalOperations_();
  }

  rewriteIfRequired_() {
    if (this.isCurrentlyProcessingPendingOperations_) return;
    if (this.pendingLocalOperations_.length > 0) return;
    if (state.getLastOpNum() - this.lastFullMapNum_ <= 10) return;
    const num = state.getLastOpNum();
    // To minimize two clients trying to rewrite precisely at the same time,
    // there's some basic requirement on the current operation num.
    if (num % 3 != 0) return;

    const snapshot = JSON.parse(JSON.stringify(state.pstate_));
    const payloadPath = `/maps/${state.getMid()}/payload`;
    firebase.database().ref(payloadPath).transaction(currData => {
      if (currData) {
        // Verify the current fullMap isn't the same or newer.
        if (currData.fullMap && currData.fullMap.lastOpNum >= num) return;
        // Verify the latest operation is the current one.
        if (currData.latestOperation && currData.latestOperation.n != num) {
          return;
        }
      }

      // Override the entire payload :-)
      return {
        fullMap: snapshot,
      };
    }, (error, committed, snapshot) => {
      if (!error && committed) {
        this.lastFullMapNum_ = num;
      }
    }, false /* suppress updates on intermediate states */);
  }
}
