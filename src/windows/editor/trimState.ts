export interface TrimState {
  duration: number;
  inPoint: number;
  outPoint: number;
}

export function initialTrimState(duration: number): TrimState {
  return { duration, inPoint: 0, outPoint: duration };
}

const MIN_GAP = 0.1;

export function setInPoint(state: TrimState, time: number): TrimState {
  const clamped = Math.max(0, Math.min(time, state.outPoint - MIN_GAP));
  return { ...state, inPoint: clamped };
}

export function setOutPoint(state: TrimState, time: number): TrimState {
  const clamped = Math.min(state.duration, Math.max(time, state.inPoint + MIN_GAP));
  return { ...state, outPoint: clamped };
}
