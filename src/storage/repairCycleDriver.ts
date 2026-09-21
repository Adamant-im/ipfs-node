export type RepairTrigger = 'startup' | 'schedule' | 'continuation' | 'manual'

export interface RepairPassResult {
  cycleCompleted: boolean
}

export interface RepairCycleDriverOptions<T extends RepairPassResult> {
  delayMs: number
  runPass: () => Promise<T>
  busyError: () => Error
  /** Consecutive failed passes tolerated before the current cycle is given up. */
  maxConsecutiveFailures?: number
  onStart?: (trigger: RepairTrigger) => void
  onError?: (error: Error) => void
  /** Reports a cycle ended by repeated failures rather than by completing. */
  onAbandon?: (error: Error, failures: number) => void
}

/**
 * Retries tolerated before a cycle is given up.
 *
 * A failed pass is retried because the persisted cursor is untouched, but an
 * endpoint that keeps failing must not retry every `delayMs` forever.
 */
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3

/** Coordinate scheduled, continued, and manual passes of one repair cycle. */
export class RepairCycleDriver<T extends RepairPassResult> {
  private active: Promise<T> | undefined
  private continuationTimer: NodeJS.Timeout | undefined
  private stopped = true
  private consecutiveFailures = 0

  constructor(private readonly options: RepairCycleDriverOptions<T>) {}

  /** Start periodic-cycle ownership and immediately run the first bounded pass. */
  start(): void {
    this.stopped = false
    this.consecutiveFailures = 0
    void this.runAutomatic('startup')
  }

  /** Start a pass for a cron schedule tick unless a cycle is already continuing. */
  triggerSchedule(): void {
    void this.runAutomatic('schedule')
  }

  /**
   * Run an operator-requested pass through the same continuation driver.
   *
   * Refused while stopped: a pass admitted after shutdown began would write
   * cycle evidence that nothing waits for, against a closing datastore.
   */
  runManual(): Promise<T> {
    if (this.stopped || this.active !== undefined) return Promise.reject(this.options.busyError())
    return this.run('manual')
  }

  /** Stop future passes and wait for the active pass to finish. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.continuationTimer !== undefined) clearTimeout(this.continuationTimer)
    this.continuationTimer = undefined
    await this.active
  }

  private async runAutomatic(trigger: Exclude<RepairTrigger, 'manual'>): Promise<void> {
    if (this.stopped) return
    if (this.continuationTimer !== undefined && trigger !== 'continuation') return
    if (this.active !== undefined) {
      if (trigger === 'continuation') this.scheduleContinuation()
      return
    }

    try {
      await this.run(trigger)
    } catch (error) {
      this.options.onError?.(error as Error)
    }
  }

  private run(trigger: RepairTrigger): Promise<T> {
    // Only a continuation inherits the failure budget; every other trigger
    // takes ownership of the cycle and starts counting again.
    if (trigger !== 'continuation') this.consecutiveFailures = 0

    this.options.onStart?.(trigger)
    const pass = this.options.runPass()
    this.active = pass

    void pass.then(
      (report) => {
        this.consecutiveFailures = 0
        if (report.cycleCompleted) this.cancelContinuation()
        else this.scheduleContinuation()
      },
      (error: Error) => this.onPassFailed(error)
    )
    void pass.then(this.clearActive(pass), this.clearActive(pass))
    return pass
  }

  /**
   * Keep a cycle alive across a failed pass.
   *
   * The pass wrote no cursor, so a retry resumes exactly where it began.
   * Dropping the cycle instead costs a whole schedule interval, and
   * `health.repairMaxAgeMs` is measured from cycle completion, so a transient
   * datastore error would otherwise be enough to expire node readiness.
   */
  private onPassFailed(error: Error): void {
    this.consecutiveFailures += 1

    const limit = this.options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
    if (this.consecutiveFailures >= limit) {
      this.cancelContinuation()
      this.options.onAbandon?.(error, this.consecutiveFailures)
      return
    }

    this.scheduleContinuation()
  }

  private clearActive(pass: Promise<T>): () => void {
    return () => {
      if (this.active === pass) this.active = undefined
    }
  }

  private scheduleContinuation(): void {
    if (this.stopped || this.continuationTimer !== undefined) return
    this.continuationTimer = setTimeout(() => {
      this.continuationTimer = undefined
      void this.runAutomatic('continuation')
    }, this.options.delayMs)
    this.continuationTimer.unref()
  }

  private cancelContinuation(): void {
    if (this.continuationTimer !== undefined) clearTimeout(this.continuationTimer)
    this.continuationTimer = undefined
  }
}
