/**
 * Run `task` at most once concurrently; later callers await the same promise.
 */
export function createInFlightPass<T>(): (task: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | undefined

  return (task: () => Promise<T>): Promise<T> => {
    if (inFlight !== undefined) {
      return inFlight
    }

    inFlight = task().finally(() => {
      inFlight = undefined
    })

    return inFlight
  }
}
