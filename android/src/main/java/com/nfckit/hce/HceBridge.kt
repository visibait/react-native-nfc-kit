package com.nfckit.hce

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * The join between Android's HCE service and the module.
 *
 * It has to be process-wide state, and that is worth explaining rather than
 * apologising for. Android starts a `HostApduService` on its own terms: the
 * platform binds it when a terminal taps, with no reference to the app's
 * Activity and no guarantee that a React Native context exists. So the service
 * cannot hold a reference to the module, and the module cannot hold one to the
 * service. This object is what they both find.
 *
 * The consequence, stated plainly because it decides what HCE can do: **the app
 * has to be running for a command to reach JavaScript.** When nothing is
 * listening, the terminal still gets a defined answer -- a status word saying the
 * card is not available -- rather than silence, because silence makes a terminal
 * wait for its own timeout and then report a hardware fault.
 */
internal object HceBridge {

  /** What the module provides while it is listening. */
  interface Host {
    fun onCommand(requestId: String, command: ByteArray)
    fun onDeactivated(reason: Int)
  }

  /**
   * `6F00`, meaning "no precise diagnosis".
   *
   * The right answer when the app is not there to give a real one: a terminal
   * reads it as "this card cannot do what I asked" and moves on, which is a much
   * better outcome than the link timing out.
   */
  private val NO_HOST_RESPONSE = byteArrayOf(0x6F, 0x00)

  private class PendingCommand(val respond: (ByteArray) -> Unit) {
    val answered = AtomicBoolean(false)
  }

  @Volatile
  private var host: Host? = null

  @Volatile
  private var timeoutMs: Long = DEFAULT_TIMEOUT_MS

  @Volatile
  private var timeoutResponse: ByteArray = NO_HOST_RESPONSE

  private val pending = ConcurrentHashMap<String, PendingCommand>()
  private val counter = AtomicInteger(0)

  /**
   * One thread, created once, for the response deadlines.
   *
   * A daemon so it can never keep the process alive, and shared rather than
   * per-command because a terminal tap is a burst of commands and creating a
   * timer thread for each one would be absurd.
   */
  private val deadlines: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor { runnable ->
      Thread(runnable, "nfc-kit-hce-deadline").apply { isDaemon = true }
    }

  const val DEFAULT_TIMEOUT_MS = 1_000L

  val active: Boolean
    get() = host != null

  fun attach(host: Host, timeoutMs: Long, timeoutResponse: ByteArray) {
    this.timeoutMs = timeoutMs
    this.timeoutResponse = timeoutResponse
    this.host = host
  }

  fun detach() {
    host = null
    // Anything in flight is answered rather than abandoned: the terminal is
    // holding the field open waiting, and it has no way to know the app went
    // away.
    for (id in pending.keys.toList()) {
      answer(id, NO_HOST_RESPONSE)
    }
  }

  /**
   * Hands a command to the module.
   *
   * Returns the response to send straight back, or `null` when the module will
   * answer later through [answer] -- which is what `processCommandApdu`'s contract
   * asks for, and the only way a round trip to JavaScript can fit inside it.
   */
  fun dispatch(command: ByteArray, respond: (ByteArray) -> Unit): ByteArray? {
    val current = host ?: return NO_HOST_RESPONSE

    val requestId = "hce-${counter.incrementAndGet()}"
    val entry = PendingCommand(respond)
    pending[requestId] = entry

    // Armed before the command is handed over, not after: if the module answers
    // synchronously the deadline finds nothing pending and does nothing, whereas
    // arming afterwards leaves a window with no deadline at all.
    deadlines.schedule(
      {
        // A terminal will not wait forever, and neither will the RF link. A late
        // answer is worse than a definite one, so the deadline wins.
        answer(requestId, timeoutResponse)
      },
      timeoutMs,
      TimeUnit.MILLISECONDS,
    )

    current.onCommand(requestId, command)
    return null
  }

  /**
   * Sends a response for one command, at most once.
   *
   * `AtomicBoolean` rather than a flag, because the module and the deadline can
   * genuinely race: an answer arriving as the deadline fires would otherwise call
   * `sendResponseApdu` twice, and the second call is a protocol violation the
   * platform reports as an unrelated failure later.
   */
  fun answer(requestId: String, response: ByteArray): Boolean {
    val entry = pending.remove(requestId) ?: return false
    if (!entry.answered.compareAndSet(false, true)) {
      return false
    }
    entry.respond(response)
    return true
  }

  fun deactivated(reason: Int) {
    // Every command still waiting belongs to a link that no longer exists.
    for (id in pending.keys.toList()) {
      pending.remove(id)
    }
    host?.onDeactivated(reason)
  }
}
