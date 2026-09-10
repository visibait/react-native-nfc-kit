package com.nfckit

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.nfc.NfcAdapter
import android.os.Build
import android.provider.Settings
import android.content.ComponentName
import android.content.pm.PackageManager
import android.nfc.cardemulation.CardEmulation
import android.nfc.cardemulation.HostApduService
import com.nfckit.background.IntentTags
import com.nfckit.hce.HceBridge
import com.nfckit.hce.NfcKitHostApduService
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
private const val CONTRACT_VERSION = 6

private const val EVENT_TAG_DISCOVERED = "onTagDiscovered"
private const val EVENT_BACKGROUND_TAG = "onBackgroundTag"
private const val EVENT_TAG_LOST = "onTagLost"
private const val EVENT_SESSION_INVALIDATED = "onSessionInvalidated"
private const val EVENT_AVAILABILITY_CHANGED = "onAvailabilityChanged"
private const val EVENT_HCE_COMMAND = "onHceCommand"
private const val EVENT_HCE_DEACTIVATED = "onHceDeactivated"
private const val EVENT_POLLING_FRAMES = "onPollingFrames"

/** The API level that added observe mode and polling loop frames. */
private const val OBSERVE_MODE_SDK = 35

/** The API level that added `NfcAdapter.getNfcAntennaInfo`. */
private const val ANTENNA_INFO_SDK = 34

/** The API level that added the secure NFC setting. */
private const val SECURE_NFC_SDK = 29

/** Mirrors `NativePollingLoopFilter`. */
class PollingLoopFilterOptions : Record {
  @Field val pattern: String = ""
  @Field val isPattern: Boolean = false
  @Field val autoTransact: Boolean = false
}

/** Mirrors `NativeHceOptions`. */
class HceOptions : Record {
  @Field val timeoutMs: Int = 1_000
  @Field val timeoutStatus: Int = 0x6F00
  @Field val aids: List<String>? = null
  @Field val preferSelf: Boolean = true
  @Field val observeMode: Boolean = false
  @Field val pollingLoopFilters: List<PollingLoopFilterOptions>? = null
}

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
        // Whether the app can actually be selected still depends on an HCE
        // service and AIDs in its manifest, which is the config plugin's job.
        // This says the controller implements host card emulation.
        "hce" to hasHceFeature(),
        // Asked of the controller, not inferred from the API level: observe mode
        // is a hardware capability and plenty of API 35 devices do not have it.
        "observeMode" to isObserveModeSupported(),
        // Polling frames only need the platform, since the callback that carries
        // them is on the service rather than on the controller.
        "pollingFrames" to (Build.VERSION.SDK_INT >= OBSERVE_MODE_SDK),
        // Whether the app actually receives them still depends on the intent
        // filters in its manifest, which is the config plugin's job. This says
        // the module can deliver one when the system dispatches it.
        "backgroundReading" to true,
        // Apple Wallet passes are an Apple protocol read through CoreNFC's own VAS
        // session. There is no Android equivalent to expose.
        "vas" to false,
        // Asked of the device rather than inferred from the API level: the
        // manufacturer has to have filled the numbers in, and plenty of API 34
        // devices answer null.
        "antennaInfo" to (antennaInfoPayload() != null),
        // Hardware-dependent as well as version-dependent, so the adapter is the
        // one to ask.
        "secureNfc" to isSecureNfcSupported(),
      )
    }

    Events(
      EVENT_TAG_DISCOVERED,
      EVENT_BACKGROUND_TAG,
      EVENT_TAG_LOST,
      EVENT_SESSION_INVALIDATED,
      EVENT_AVAILABILITY_CHANGED,
      EVENT_HCE_COMMAND,
      EVENT_HCE_DEACTIVATED,
      EVENT_POLLING_FRAMES,
    )

    /* -- Availability ---------------------------------------------------- */

    AsyncFunction("isSupported") { nfcAdapter() != null }

    AsyncFunction("isEnabled") { nfcAdapter()?.isEnabled == true }

    AsyncFunction("openSettings") {
      val activity = requireActivity()
      activity.startActivity(Intent(Settings.ACTION_NFC_SETTINGS))
    }

    AsyncFunction("getAntennaInfo") { antennaInfoPayload() }

    AsyncFunction("isSecureNfcEnabled") {
      Build.VERSION.SDK_INT >= SECURE_NFC_SDK && nfcAdapter()?.isSecureNfcEnabled == true
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

    /* -- Card emulation --------------------------------------------------- */

    AsyncFunction("isHceSupported") { hasHceFeature() }

    AsyncFunction("isObserveModeSupported") { isObserveModeSupported() }

    AsyncFunction("isObserveModeEnabled") {
      Build.VERSION.SDK_INT >= OBSERVE_MODE_SDK && readerMode.requireAdapter().isObserveModeEnabled
    }

    /**
     * Holds the card silent, or lets it answer again.
     *
     * The platform grants this only to the service it currently prefers, which is
     * why `startHce` claims preferred-service status. `false` here means the
     * platform refused, not that nothing was attempted -- reporting it beats an
     * app believing its card is silent when it is not.
     */
    AsyncFunction("setObserveModeEnabled") { enabled: Boolean ->
      if (Build.VERSION.SDK_INT < OBSERVE_MODE_SDK) {
        throw NfcException(
          NfcErrorCode.UNSUPPORTED_PLATFORM,
          "Observe mode needs Android 15 (API 35); this device is API ${Build.VERSION.SDK_INT}. " +
            "Guard with capabilities.observeMode.",
        )
      }
      val adapter = readerMode.requireAdapter()
      if (!adapter.isObserveModeSupported) {
        throw NfcException(
          NfcErrorCode.HCE_UNSUPPORTED,
          "This device's NFC controller does not implement observe mode.",
        )
      }
      adapter.setObserveModeEnabled(enabled)
    }

    AsyncFunction("startHce") { options: HceOptions ->
      if (!hasHceFeature()) {
        throw NfcException(
          NfcErrorCode.HCE_UNSUPPORTED,
          "This device's NFC controller does not implement host card emulation.",
        )
      }
      if (HceBridge.active) {
        throw NfcException(
          NfcErrorCode.SYSTEM_BUSY,
          "Card emulation is already running. Stop it before starting another session.",
        )
      }

      options.aids?.let { registerAids(it) }
      options.pollingLoopFilters?.let { registerPollingLoopFilters(it) }

      val timeoutResponse = byteArrayOf(
        ((options.timeoutStatus shr 8) and 0xFF).toByte(),
        (options.timeoutStatus and 0xFF).toByte(),
      )

      HceBridge.attach(
        object : HceBridge.Host {
          override fun onCommand(requestId: String, command: ByteArray) {
            sendEvent(
              EVENT_HCE_COMMAND,
              mapOf("requestId" to requestId, "commandHex" to Hex.encode(command)),
            )
          }

          override fun onDeactivated(reason: Int) {
            sendEvent(EVENT_HCE_DEACTIVATED, mapOf("reason" to deactivationReason(reason)))
          }

          override fun onPollingFrames(frames: List<Map<String, Any?>>) {
            sendEvent(EVENT_POLLING_FRAMES, mapOf("frames" to frames))
          }
        },
        timeoutMs = options.timeoutMs.toLong(),
        timeoutResponse = timeoutResponse,
      )

      // Claimed after attaching, so a tap landing during setup is answered by the
      // handler rather than by the fallback.
      val preferred = if (options.preferSelf) preferSelf() else false
      val observing = if (options.observeMode) enterObserveMode() else false

      mapOf("preferred" to preferred, "observeMode" to observing)
    }

    AsyncFunction("stopHce") {
      // Observe mode first: leaving it on would hold every other card emulation
      // app on the device silent as well, and nothing else would turn it off.
      if (Build.VERSION.SDK_INT >= OBSERVE_MODE_SDK) {
        runCatching { readerMode.requireAdapter().setObserveModeEnabled(false) }
      }
      currentActivityOrNull()?.let { activity ->
        runCatching { cardEmulation()?.unsetPreferredService(activity) }
      }
      HceBridge.detach()
    }

    AsyncFunction("respondToHce") { requestId: String, response: ByteArray ->
      HceBridge.answer(requestId, response)
    }

    /* -- Wallet passes ---------------------------------------------------- */

    AsyncFunction("isVasSupported") { false }

    AsyncFunction("readVas") { _: Map<String, Any?> ->
      unsupportedHere<List<Map<String, Any?>>>(
        "Reading an Apple Wallet pass uses CoreNFC's VAS session, which exists only on iOS. " +
          "Guard with capabilities.vas.",
      )
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

  /**
   * Refuses a call that only exists on the other platform.
   *
   * Typed rather than simply throwing, because a lambda whose body always throws
   * infers `Nothing`, and the module DSL cannot use that as a reified type. The
   * type parameter gives the function a real signature while the body still never
   * returns.
   */
  private fun <T> unsupportedHere(reason: String): T =
    throw NfcException(NfcErrorCode.UNSUPPORTED_PLATFORM, reason)

  private fun cardEmulation(): CardEmulation? =
    nfcAdapter()?.let { CardEmulation.getInstance(it) }

  private fun isObserveModeSupported(): Boolean =
    Build.VERSION.SDK_INT >= OBSERVE_MODE_SDK && nfcAdapter()?.isObserveModeSupported == true

  private fun isSecureNfcSupported(): Boolean =
    Build.VERSION.SDK_INT >= SECURE_NFC_SDK && nfcAdapter()?.isSecureNfcSupported == true

  /**
   * This device's antenna layout, in the shape `NativeNfcAntennaInfo` describes,
   * or null.
   *
   * Null covers three situations deliberately: below API 34 the call does not
   * exist, there may be no adapter at all, and a manufacturer on API 34 may
   * simply not have filled the numbers in. None of them is an error, and a caller
   * that handles the third one has already handled the other two.
   *
   * The platform type never appears in a signature here, only inside the guarded
   * branch, so nothing in this class references an API 34 class on a device that
   * does not have one.
   */
  private fun antennaInfoPayload(): Map<String, Any?>? {
    if (Build.VERSION.SDK_INT < ANTENNA_INFO_SDK) {
      return null
    }
    val info = nfcAdapter()?.nfcAntennaInfo ?: return null

    return mapOf(
      "deviceWidth" to info.deviceWidth,
      "deviceHeight" to info.deviceHeight,
      "deviceFoldable" to info.isDeviceFoldable,
      "antennas" to info.availableNfcAntennas.map { antenna ->
        mapOf("locationX" to antenna.locationX, "locationY" to antenna.locationY)
      },
    )
  }

  /**
   * Asks the platform to route taps to this app's service while it is in front.
   *
   * Without it the user's default wallet keeps the tap, which is the right default
   * for a phone in general and the wrong one for an app the user is looking at. It
   * is also what the platform requires before it will let the app control observe
   * mode or see polling frames.
   *
   * The platform scopes this to a foreground activity and drops it on its own when
   * the activity goes, so there is nothing to unwind beyond `unsetPreferredService`.
   * Returns whether it was actually claimed, rather than assuming.
   */
  private fun preferSelf(): Boolean {
    val activity = currentActivityOrNull() ?: return false
    val emulation = cardEmulation() ?: return false
    val component = ComponentName(activity, NfcKitHostApduService::class.java)

    return runCatching { emulation.setPreferredService(activity, component) }.getOrDefault(false)
  }

  private fun enterObserveMode(): Boolean {
    if (!isObserveModeSupported()) {
      return false
    }
    val adapter = readerMode.requireAdapter()
    val emulation = cardEmulation() ?: return false
    val context = appContext.reactContext ?: return false

    // Also asked for as the service's default, so a tap arriving before the app
    // has finished starting is held rather than answered.
    runCatching {
      emulation.setShouldDefaultToObserveModeForService(
        ComponentName(context, NfcKitHostApduService::class.java),
        true,
      )
    }

    return runCatching { adapter.setObserveModeEnabled(true) }.getOrDefault(false)
  }

  /**
   * Registers the polling loop frames this app's service wants to see.
   *
   * A plain filter matches a frame's data as a hexadecimal prefix; a pattern one
   * matches it as a regular expression. `autoTransact` tells the platform to leave
   * observe mode by itself when a frame matches, which is the low-latency route
   * for a reader the app already trusts -- at the cost of the confirmation step
   * observe mode exists to allow.
   */
  private fun registerPollingLoopFilters(filters: List<PollingLoopFilterOptions>) {
    if (Build.VERSION.SDK_INT < OBSERVE_MODE_SDK) {
      throw NfcException(
        NfcErrorCode.UNSUPPORTED_PLATFORM,
        "Polling loop filters need Android 15 (API 35); this device is API " +
          "${Build.VERSION.SDK_INT}. Guard with capabilities.pollingFrames.",
      )
    }

    val context = appContext.reactContext
      ?: throw NfcException(NfcErrorCode.INTERNAL_ERROR, "No context to register filters with.")
    val emulation = cardEmulation()
      ?: throw NfcException(NfcErrorCode.NFC_UNSUPPORTED, "This device has no NFC adapter.")
    val component = ComponentName(context, NfcKitHostApduService::class.java)

    for (filter in filters) {
      val registered = try {
        if (filter.isPattern) {
          emulation.registerPollingLoopPatternFilterForService(
            component,
            filter.pattern,
            filter.autoTransact,
          )
        } else {
          emulation.registerPollingLoopFilterForService(
            component,
            filter.pattern,
            filter.autoTransact,
          )
        }
      } catch (cause: RuntimeException) {
        throw NfcException.from(
          NfcErrorCode.INVALID_ARGUMENT,
          "The system refused the polling loop filter \"${filter.pattern}\".",
          cause,
        )
      }

      if (!registered) {
        throw NfcException(
          NfcErrorCode.INVALID_ARGUMENT,
          "The system refused the polling loop filter \"${filter.pattern}\". A plain filter is " +
            "hexadecimal; a pattern filter is a regular expression over hexadecimal.",
        )
      }
    }
  }

  private fun hasHceFeature(): Boolean =
    appContext.reactContext
      ?.packageManager
      ?.hasSystemFeature(PackageManager.FEATURE_NFC_HOST_CARD_EMULATION) == true

  /** Android's deactivation reasons, as names rather than as integers. */
  private fun deactivationReason(reason: Int): String =
    when (reason) {
      HostApduService.DEACTIVATION_DESELECTED -> "deselected"
      else -> "linkLoss"
    }

  /**
   * Replaces the AIDs registered for this app's HCE service.
   *
   * The service still has to be declared in the manifest -- that is what makes the
   * app eligible at all -- but the AIDs it answers for can change without a
   * rebuild, which is the whole point of doing it here.
   *
   * Only the "other" category. Payment AIDs additionally require the user to have
   * chosen the app as their default wallet, which is a flow an app has to run
   * deliberately rather than something a library should arrange behind its back.
   */
  private fun registerAids(aids: List<String>) {
    val context = appContext.reactContext
      ?: throw NfcException(NfcErrorCode.INTERNAL_ERROR, "No context to register AIDs with.")
    val adapter = readerMode.requireAdapter()
    val emulation = CardEmulation.getInstance(adapter)
    val component = ComponentName(context, NfcKitHostApduService::class.java)

    val registered = try {
      emulation.registerAidsForService(component, CardEmulation.CATEGORY_OTHER, aids)
    } catch (cause: RuntimeException) {
      throw NfcException.from(
        NfcErrorCode.HCE_UNSUPPORTED,
        "The system refused to register these AIDs. Check that the HCE service is declared in " +
          "the manifest and that each AID is valid hexadecimal of 5 to 16 bytes.",
        cause,
      )
    }

    if (!registered) {
      throw NfcException(
        NfcErrorCode.HCE_UNSUPPORTED,
        "The system refused to register these AIDs for the HCE service. The most common reason " +
          "is that another app already owns one of them, or that the service is missing from " +
          "the manifest -- add the react-native-nfc-kit plugin's android.hce option and rebuild.",
      )
    }
  }

  private fun teardown() {
    val active = session
    session = null
    readerMode.unwant(currentActivityOrNull())
    tagLostWatcher.stopAll()
    active?.closeAll()

    backgroundHandles.values.forEach { it.close() }
    backgroundHandles.clear()

    // A stale host would leave the service handing commands to a JavaScript
    // context that no longer exists, and the terminal waiting for the deadline.
    HceBridge.detach()
  }
}
