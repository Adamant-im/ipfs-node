export type RepairTrigger = 'startup' | 'schedule' | 'continuation' | 'manual'

export interface RepairPassResult {
  cycleCompleted: boolean
}

export interface RepairCycleDriverOptions<T extends RepairPassResult> {
  delayMs: number
  runPass: () => Promise<T>
  busyError: () => Error
  onStart?: (trigger: RepairTrigger) => void
  onError?: (error: Error) => void
}

/** Coordinate scheduled, continued, and manual passes of one repair cycle. */
export class RepairCycleDriver<T extends RepairPassResult> {
  private active: Promise<T> | undefined
  private continuationTimer: NodeJS.Timeout | undefined
  private stopped = true

  constructor(private readonly options: RepairCycleDriverOptions<T>) {}

  /** Start periodic-cycle ownership and immediately run the first bounded pass. */
  start(): void {
    this.stopped = false
    void this.runAutomatic('startup')
  }

  /** Start a pass for a cron schedule tick unless a cycle is already continuing. */
  triggerSchedule(): void {
    void this.runAutomatic('schedule')
  }

  /** Run an operator-requested pass through the same continuation driver. */
  runManual(): Promise<T> {
    if (this.active !== undefined) return Promise.reject(this.options.busyError())
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
    this.options.onStart?.(trigger)
    const pass = this.options.runPass()
    this.active = pass

    void pass.then(
      (report) => {
        if (report.cycleCompleted) this.cancelContinuation()
        else this.scheduleContinuation()
      },
      () => undefined
    )
    void pass.then(this.clearActive(pass), this.clearActive(pass))
    return pass
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
