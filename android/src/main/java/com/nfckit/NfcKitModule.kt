package com.nfckit

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.nfc.NfcAdapter
import android.os.Build
import android.provider.Settings
import com.nfckit.background.IntentTags
import com.nfckit.reader.NfcKitReaderCallback
import com.nfckit.reader.ReaderModeController
import com.nfckit.reader.ReaderOptions
import com.nfckit.reader.TagHandle
import com.nfckit.reader.TagIo
import com.nfckit.reader.TagLostWatcher
import com.nfckit.tech.TechRegistry
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Bumped together with `CONTRACT_VERSION` in `src/native/contract.ts`. */
private const val CONTRACT_VERSION = 2

private const val EVENT_TAG_DISCOVERED = "onTagDiscovered"
private const val EVENT_BACKGROUND_TAG = "onBackgroundTag"
private const val EVENT_TAG_LOST = "onTagLost"
private const val EVENT_SESSION_INVALIDATED = "onSessionInvalidated"
private const val EVENT_AVAILABILITY_CHANGED = "onAvailabilityChanged"

/** Mirrors `NativeSessionOptions`. The iOS fields are accepted and ignored here. */
class SessionOptions : Record {
  @Field val techs: List<String> = emptyList()
  @Field val iosPollingOptions: List<String>? = null
  @Field val iosAlertMessage: String? = null
  @Field val iosInvalidateAfterFirstRead: Boolean = false
  @Field val iosSelectIdentifiers: List<String>? = null
  @Field val iosFelicaSystemCodes: List<String>? = null
  @Field val androidSkipNdefCheck: Boolean = false
  @Field val androidNoPlatformSounds: Boolean = false
  @Field val androidPresenceCheckDelayMs: Int? = null
}

/** One open reading session and the tags it has handed out. */
private class ReaderSession(val id: String, val techs: List<String>) {
  val handles = ConcurrentHashMap<String, TagHandle>()
  private val counter = AtomicInteger(0)

  fun nextHandleId(): String = "$id-t${counter.incrementAndGet()}"

  fun closeAll() {
    handles.values.forEach { it.close() }
    handles.clear()
  }
}

class NfcKitModule : Module() {

  private var session: ReaderSession? = null

  private val readerMode = ReaderModeController { nfcAdapter() }

  /**
   * Tags that arrived in an intent rather than in a session.
   *
   * Kept apart from a session's handles because their lifetimes are unrelated: a
   * background tag outlives any session and is released by whoever consumed it,
   * not by a session closing.
   */
  private val backgroundHandles = ConcurrentHashMap<String, TagHandle>()
  private val backgroundCounter = AtomicInteger(0)

  private val tagLostWatcher by lazy {
    TagLostWatcher(appContext.backgroundCoroutineScope) { sessionId, handleId ->
      sendEvent(EVENT_TAG_LOST, mapOf("sessionId" to sessionId, "handleId" to handleId))
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Context access                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * The current activity, fetched every time and never cached.
   *
   * Caching a `Context` or an `Activity` is exactly the bug that took the library
   * this replaces two releases to unwind for React Native 0.80 and 0.81: the
   * cached reference went stale across activity recreation, so `isSupported` and
   * `isEnabled` reported the wrong thing until the app restarted.
   *
   * "No foreground activity" is a first-class error rather than a string returned
   * from five different methods, because reader mode genuinely requires one.
   */
  private fun requireActivity(): Activity =
    appContext.activityProvider?.currentActivity
      ?: throw NfcException(
        NfcErrorCode.NO_ACTIVITY,
        "NFC reader mode needs a foreground activity and there is none. This usually means the " +
          "app is in the background, or the scan was started before the activity was attached.",
      )

  private fun currentActivityOrNull(): Activity? = appContext.activityProvider?.currentActivity

  private fun nfcAdapter(): NfcAdapter? {
    val context: Context = appContext.reactContext ?: return null
    return NfcAdapter.getDefaultAdapter(context)
  }

  /* ---------------------------------------------------------------------- */
  /* Definition                                                             */
  /* ---------------------------------------------------------------------- */

  override fun definition() = ModuleDefinition {
    Name("NfcKit")

    Constant("contractVersion") { CONTRACT_VERSION }

    Constant("capabilities") {
      mapOf(
        "platform" to "android",
        "osVersion" to Build.VERSION.RELEASE,
        // Every technology this build can drive. Which of them a given tag
        // actually supports is a per-tag question -- MIFARE Classic is
        // chipset-dependent -- so `tag.techs` is the authoritative answer.
        "techs" to TechRegistry.allTechNames,
        // Asked of the running platform rather than inferred from SDK_INT: this
        // is a promise about latency, and it should describe this device.
        "tagLost" to if (TagLostWatcher.platformReportsTagLost()) "native" else "polled",
        "perSessionConfig" to false,
        "hce" to false,
        // Whether the app actually receives them still depends on the intent
        // filters in its manifest, which is the config plugin's job. This says
        // the module can deliver one when the system dispatches it.
        "backgroundReading" to true,
      )
    }

    Events(
      EVENT_TAG_DISCOVERED,
      EVENT_BACKGROUND_TAG,
      EVENT_TAG_LOST,
      EVENT_SESSION_INVALIDATED,
      EVENT_AVAILABILITY_CHANGED,
    )

    /* -- Availability ---------------------------------------------------- */

    AsyncFunction("isSupported") { nfcAdapter() != null }

    AsyncFunction("isEnabled") { nfcAdapter()?.isEnabled == true }

    AsyncFunction("openSettings") {
      val activity = requireActivity()
      activity.startActivity(Intent(Settings.ACTION_NFC_SETTINGS))
    }

    /* -- Session lifecycle ----------------------------------------------- */

    AsyncFunction("startSession") { sessionId: String, options: SessionOptions ->
      val adapter = readerMode.requireAdapter()
      if (!adapter.isEnabled) {
        throw NfcException(
          NfcErrorCode.NFC_DISABLED,
          "NFC is switched off. Ask the user to enable it, or call openSettings() to take them there.",
        )
      }
      if (session != null) {
        throw NfcException(
          NfcErrorCode.SYSTEM_BUSY,
          "An NFC session is already open. Close it before starting another.",
        )
      }

      val activity = requireActivity()
      val active = ReaderSession(sessionId, options.techs)
      session = active

      try {
        readerMode.want(
          activity = activity,
          techs = options.techs,
          options = ReaderOptions(
            skipNdefCheck = options.androidSkipNdefCheck,
            noPlatformSounds = options.androidNoPlatformSounds,
            presenceCheckDelayMs = options.androidPresenceCheckDelayMs,
          ),
          callback = NfcKitReaderCallback(
            discovered = { tag -> onTagDiscovered(tag) },
            lost = { tag -> tagLostWatcher.reportFromPlatform(tag) },
          ),
        )
      } catch (error: Throwable) {
        // Never leave a half-started session behind: the next startSession would
        // report systemBusy for a session that never actually began.
        session = null
        readerMode.unwant(currentActivityOrNull())
        throw error
      }
    }

    AsyncFunction("closeSession") { sessionId: String ->
      val active = session
      if (active != null && active.id == sessionId) {
        session = null
        readerMode.unwant(currentActivityOrNull())
        tagLostWatcher.stopAll()
        active.closeAll()
      }
      // Closing an already-closed session is not an error. JavaScript closes in a
      // finally block, which can legitimately run after the platform already
      // ended the session.
    }

    AsyncFunction("setSessionAlert") { _: String, _: String ->
      // iOS shows a system sheet whose text can be updated mid-scan. Android has
      // no equivalent, and the app owns its own UI, so this is a no-op rather
      // than an error: cross-platform code should not have to branch for it.
    }

    /* -- Tag operations --------------------------------------------------- */

    AsyncFunction("releaseTag") Coroutine { handleId: String ->
      tagLostWatcher.stop(handleId)
      withContext(TagIo.dispatcher) {
        (session?.handles?.remove(handleId) ?: backgroundHandles.remove(handleId))?.close()
      }
    }

    AsyncFunction("readNdef") Coroutine { handleId: String ->
      onTagIo(handleId) { it.readNdef() }
    }

    AsyncFunction("writeNdef") Coroutine { handleId: String, message: ByteArray ->
      onTagIo(handleId) { it.writeNdef(message) }
    }

    AsyncFunction("getNdefStatus") Coroutine { handleId: String ->
      onTagIo(handleId) { handle ->
        val status = handle.ndefStatus()
        mapOf(
          "writable" to status.writable,
          "capacity" to status.capacity,
          "canMakeReadOnly" to status.canMakeReadOnly,
          "typeName" to status.typeName,
        )
      }
    }

    AsyncFunction("makeNdefReadOnly") Coroutine { handleId: String ->
      onTagIo(handleId) { it.makeNdefReadOnly() }
    }

    AsyncFunction("formatNdef") Coroutine { handleId: String, message: ByteArray ->
      onTagIo(handleId) { it.formatNdef(message) }
    }

    AsyncFunction("transceive") Coroutine { handleId: String, tech: String, data: ByteArray ->
      onTagIo(handleId) { it.transceive(tech, data) }
    }

    AsyncFunction("getMaxTransceiveLength") Coroutine { handleId: String, tech: String ->
      onTagIo(handleId) { it.maxTransceiveLength(tech) }
    }

    AsyncFunction("setTechTimeout") Coroutine { handleId: String, tech: String, timeoutMs: Int ->
      onTagIo(handleId) { it.setTechTimeout(tech, timeoutMs) }
    }

    AsyncFunction("getTechTimeout") Coroutine { handleId: String, tech: String ->
      onTagIo(handleId) { it.getTechTimeout(tech) }
    }

    AsyncFunction("takeLaunchTag") {
      // Read from the activity's intent on demand rather than captured at
      // startup, so it works whether JavaScript asks immediately or several
      // screens later. `IntentTags.take` clears the extra, which is what stops a
      // screen rotation from delivering the same tap a second time.
      takeIntentTag(currentActivityOrNull()?.intent)
    }

    /* -- Lifecycle -------------------------------------------------------- */

    OnActivityEntersForeground {
      // Reader mode belongs to the foreground activity, so it has to be
      // re-established after the app comes back. The session survives; only the
      // radio was released.
      currentActivityOrNull()?.let { readerMode.resumeIfWanted(it) }
    }

    OnActivityEntersBackground {
      readerMode.suspend(currentActivityOrNull())
    }

    OnNewIntent { intent ->
      // Fires for every intent the activity receives, most of which have nothing
      // to do with NFC; `IntentTags` answers null for those.
      takeIntentTag(intent)?.let { info -> sendEvent(EVENT_BACKGROUND_TAG, mapOf("tag" to info)) }
    }

    OnActivityDestroys {
      teardown()
    }

    OnDestroy {
      teardown()
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  /** Runs a tag operation on the dedicated I/O thread. */
  private suspend fun <T> onTagIo(handleId: String, block: (TagHandle) -> T): T =
    withContext(TagIo.dispatcher) {
      val handle = session?.handles?.get(handleId)
        ?: backgroundHandles[handleId]
        ?: throw NfcException(
          NfcErrorCode.SESSION_CLOSED,
          "This tag is no longer available: its session has been closed.",
        )
      block(handle)
    }

  /**
   * Called on the NFC service's own thread when a tag enters the field.
   *
   * Everything here is cheap and non-blocking -- reading a tech list touches no
   * radio -- so it is safe to do inline. The first actual exchange happens later,
   * on the tag-I/O thread, when JavaScript asks for something.
   */
  private fun onTagDiscovered(tag: android.nfc.Tag) {
    val active = session ?: return
    val handle = TagHandle(active.nextHandleId(), tag)
    active.handles[handle.id] = handle
    tagLostWatcher.watch(active.id, handle)

    sendEvent(EVENT_TAG_DISCOVERED, mapOf("sessionId" to active.id, "tag" to tagInfo(handle)))
  }

  /**
   * Turns an NFC intent into a usable tag, or answers null.
   *
   * Background tags are deliberately not watched for removal. By the time the app
   * is running the card is almost always gone already, so a watcher would do
   * nothing but announce that immediately, and `onLost` for a tag that was never
   * in the field while the app was looking is noise rather than information.
   */
  private fun takeIntentTag(intent: Intent?): Map<String, Any?>? {
    val dispatched = IntentTags.take(intent) ?: return null
    val handle = TagHandle(
      id = "bg-${backgroundCounter.incrementAndGet()}",
      tag = dispatched.tag,
      dispatchedNdef = dispatched.ndefMessage,
    )
    backgroundHandles[handle.id] = handle
    return tagInfo(handle)
  }

  private fun tagInfo(handle: TagHandle): Map<String, Any?> =
    mapOf(
      "handleId" to handle.id,
      "idHex" to handle.idHex,
      "techs" to handle.techs,
      "android" to mapOf(
        "techList" to handle.androidTechList,
        "maxTransceiveLength" to null,
        "hiLayerResponseHex" to null,
        "historicalBytesHex" to null,
      ),
      "ios" to null,
    )

  private fun teardown() {
    val active = session
    session = null
    readerMode.unwant(currentActivityOrNull())
    tagLostWatcher.stopAll()
    active?.closeAll()

    backgroundHandles.values.forEach { it.close() }
    backgroundHandles.clear()
  }
}
