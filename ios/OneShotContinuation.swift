import Foundation

/**
 A continuation that can be resumed at most once, structurally.

 This is the single most important type in the iOS implementation, and it exists
 because of a specific, shipped bug rather than a theoretical one.

 CoreNFC is delegate-based, so bridging it to `async` means holding a
 continuation across a callback. Resuming one twice is undefined behaviour in
 Swift and a hard crash under React Native's New Architecture. The library this
 replaces has exactly that: `getTag` calls its callback for the "no session"
 case and then falls through and calls it again, which is issue #833 -- and its
 Android side catches the resulting exception and discards it with an apologetic
 comment, which hides the same class of bug rather than fixing it.

 The obvious remedy is a `guard` before every resume. That works right up until
 the day somebody adds a path and forgets one. Making a second resume impossible
 rather than merely discouraged is the difference between a fixed bug and a
 fixed instance of a bug.

 An actor rather than a lock: resumes arrive from CoreNFC's delegate queue and
 from timeout tasks, and serialising them is the whole job.
 */
internal actor OneShotContinuation<Value: Sendable> {
  private var continuation: CheckedContinuation<Value, Error>?
  private var isSettled = false

  /// Whether the continuation has already been resumed.
  var settled: Bool { isSettled }

  /// Stores the continuation to be resumed later.
  func attach(_ continuation: CheckedContinuation<Value, Error>) {
    // Attaching after a resume would strand the caller forever. This only
    // happens if a result arrived before `withCheckedThrowingContinuation` got
    // to store it, which is a real ordering possible with a delegate queue.
    if isSettled {
      if let pending = pendingResult {
        pendingResult = nil
        resume(continuation, with: pending)
        return
      }
      continuation.resume(
        throwing: NfcException(NfcErrorCode.internalError, "The NFC operation settled before it started.")
      )
      return
    }
    self.continuation = continuation
  }

  /// A result that arrived before the continuation was attached.
  private var pendingResult: Result<Value, Error>?

  func resume(returning value: Value) {
    settle(.success(value))
  }

  func resume(throwing error: Error) {
    settle(.failure(error))
  }

  private func settle(_ result: Result<Value, Error>) {
    guard !isSettled else {
      // A second resume is dropped rather than crashing. Native delivering the
      // same callback twice is a bug in the platform or in this module, and it
      // must not become a crash in the app that happens to be using it.
      return
    }
    isSettled = true

    guard let continuation else {
      // Settled before anyone awaited it: hold the result for `attach`.
      pendingResult = result
      return
    }
    self.continuation = nil
    resume(continuation, with: result)
  }

  private nonisolated func resume(
    _ continuation: CheckedContinuation<Value, Error>,
    with result: Result<Value, Error>
  ) {
    switch result {
    case .success(let value):
      continuation.resume(returning: value)
    case .failure(let error):
      continuation.resume(throwing: error)
    }
  }
}

/**
 Awaits a value produced by a delegate callback.

 `register` runs synchronously, before the caller suspends, and hands the one-shot
 to whatever will produce the result -- typically by storing it where a CoreNFC
 delegate method can reach it.

 A result that arrives before the continuation is attached is held and delivered
 on attach, so there is no race to lose. That ordering is not hypothetical: a
 CoreNFC delegate runs on its own queue and can fire before the `await` here has
 finished setting up.
 */
internal func withOneShot<Value: Sendable>(
  _ register: (OneShotContinuation<Value>) -> Void
) async throws -> Value {
  let oneShot = OneShotContinuation<Value>()
  register(oneShot)

  return try await withCheckedThrowingContinuation { continuation in
    Task {
      await oneShot.attach(continuation)
    }
  }
}
