package com.nfckit.reader

import android.nfc.NfcAdapter
import android.nfc.Tag
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

/**
 * How often an idle tag is probed for presence.
 *
 * A compromise, and worth stating why. Each probe is a real radio round trip on
 * the tag-I/O thread, so a short interval competes with the app's own exchanges
 * and drains battery while a tag sits on the reader. A long one means the UI says
 * "hold the card still" for a while after the card has gone. 500 ms puts the
 * worst-case notice at half a second, which is below the point at which someone
 * looks up from the phone.
 */
internal const val TAG_LOST_POLL_INTERVAL_MS = 500L

/**
 * Notices when a tag has left the field.
 *
 * Android below API 37 tells an app nothing when a tag goes away: reader mode
 * hands over a tag and then stays silent, so the only way to find out is to ask.
 * That is what this does, on the tag-I/O thread so a probe can never interleave
 * with a real exchange.
 *
 * Two things make the probe safe to run against a tag an app is using:
 *
 * - While a technology is connected, `isConnected` is the probe. It is not a
 *   local flag: the platform forwards it to the NFC service, which checks the
 *   tag is genuinely still there.
 * - Only when nothing is connected does it connect and immediately close. There
 *   is no protocol state to disturb at that point, which matters — reconnecting
 *   mid-protocol would reset a card's selected application, and the app would
 *   see the failure several commands later with nothing pointing here.
 *
 * From API 37 the platform reports removal directly. [reportFromPlatform] is that
 * path; the poller stays running underneath as a backstop, so if the callback
 * does not arrive the app still learns the tag has gone.
 */
internal class TagLostWatcher(
  private val scope: CoroutineScope,
  private val intervalMs: Long = TAG_LOST_POLL_INTERVAL_MS,
  private val onLost: (sessionId: String, handleId: String) -> Unit,
) {

  private class Watch(val sessionId: String, val handle: TagHandle) {
    var job: Job? = null
  }

  private val watches = ConcurrentHashMap<String, Watch>()

  /** Starts watching a tag. Idempotent per handle. */
  fun watch(sessionId: String, handle: TagHandle) {
    val watch = Watch(sessionId, handle)
    watches.put(handle.id, watch)?.job?.cancel()

    watch.job = scope.launch {
      while (isActive) {
        delay(intervalMs)
        val present = withContext(TagIo.dispatcher) { handle.isPresent() }
        if (!present) {
          // No self-cancel: this coroutine is about to finish anyway, and
          // cancelling the job it is running in would be a needless race.
          reportOnce(handle.id, cancelJob = false)
          return@launch
        }
      }
    }
  }

  /**
   * Reports removal from the platform's own callback, on API 37 and later.
   *
   * The tag is matched by its identifier rather than by object identity: the
   * callback hands over a `Tag` the platform built for the removal, not the one
   * discovery produced.
   */
  fun reportFromPlatform(tag: Tag) {
    val id = tag.id
    val watch = watches.values.firstOrNull { it.handle.matchesTagId(id) } ?: return
    reportOnce(watch.handle.id, cancelJob = true)
  }

  /** Stops watching, without reporting. For a tag the app released itself. */
  fun stop(handleId: String) {
    watches.remove(handleId)?.job?.cancel()
  }

  fun stopAll() {
    for (id in watches.keys.toList()) {
      stop(id)
    }
  }

  /**
   * Emits the removal at most once per tag.
   *
   * `ConcurrentHashMap.remove` decides the winner, so the poller and the
   * platform callback racing to report the same tag cannot both get through —
   * which would otherwise fire every `tag.onLost` listener twice.
   */
  private fun reportOnce(handleId: String, cancelJob: Boolean) {
    val watch = watches.remove(handleId) ?: return
    if (cancelJob) {
      watch.job?.cancel()
    }
    onLost(watch.sessionId, handleId)
  }

  companion object {
    /**
     * Whether this platform declares `ReaderCallback.onTagLost(Tag)`.
     *
     * Asked of the running platform rather than assumed from `SDK_INT`, because
     * the answer decides what the library tells apps about removal latency, and
     * a capability that reports a guess is worse than one that reports nothing.
     * This module compiles against SDK 36, so the method cannot be referenced
     * directly; [NfcKitReaderCallback] declares a matching one, which the JVM
     * resolves as the override wherever the interface does have it.
     */
    fun platformReportsTagLost(): Boolean =
      runCatching {
        NfcAdapter.ReaderCallback::class.java.methods.any { method ->
          method.name == "onTagLost" &&
            method.parameterTypes.size == 1 &&
            method.parameterTypes[0] == Tag::class.java
        }
      }.getOrDefault(false)
  }
}

/**
 * The reader-mode callback.
 *
 * A named class rather than a lambda so it can carry [onTagLost]. A SAM-converted
 * lambda implements exactly one method and there would be nowhere to put it.
 */
internal class NfcKitReaderCallback(
  private val discovered: (Tag) -> Unit,
  private val lost: (Tag) -> Unit,
) : NfcAdapter.ReaderCallback {

  override fun onTagDiscovered(tag: Tag) = discovered(tag)

  /**
   * Called by the platform on API 37 and later when the tag leaves the field.
   *
   * Not marked `override`: `NfcAdapter.ReaderCallback` gained this as a default
   * method in Android 17, and this module compiles against SDK 36 where the
   * interface has no such member. Method dispatch is by name and descriptor, so
   * a platform that does declare it resolves to this implementation.
   *
   * If Android ever ships a different signature, this is simply never called and
   * the poller reports removal as it does everywhere else — which is why the
   * poller keeps running rather than being switched off on new platforms.
   */
  fun onTagLost(tag: Tag) = lost(tag)
}
