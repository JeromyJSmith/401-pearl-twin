// Observation state is attached to the existing BCF issue, in the existing viewport.
export const OBSERVATION_SCHEMA = 'marpa.capture-observation.v1';
export const FRAME_NAMES = ['model', 'capture', 'blend'];
const copy = (value) => structuredClone(value);
export function assertObservationCurrent(observation, context) {
  if (observation?.schema !== OBSERVATION_SCHEMA) throw new Error('This comparison format is not supported.');
  for (const field of ['model_sha256', 'parameter_sha256', 'edits_sha256', 'presentation_sha256']) {
    if ((observation.revision?.[field] ?? null) !== (context.revision?.[field] ?? null)) throw new Error('This comparison belongs to an earlier model. Save a new comparison.');
  }
  if (!/^[a-f0-9]{64}$/.test(observation.revision?.model_sha256 || '')) throw new Error('The model revision is unavailable. Reload before saving.');
  if (!observation.captures?.length) throw new Error('Turn on a capture before saving a comparison.');
  for (const capture of observation.captures) {
    const current = context.captures?.find((c) => c.key === capture.key);
    if (!current || current.sha256 !== capture.sha256 || current.placement_sha256 !== capture.placement_sha256) throw new Error('The capture has changed. Reload before replaying this comparison.');
    if (!/^[a-f0-9]{64}$/.test(capture.sha256 || '')) throw new Error('The capture revision is unavailable.');
  }
  return true;
}
export function makeObservation({ context, state, captures, element, room, title }) {
  const observation = { schema: OBSERVATION_SCHEMA, created: new Date().toISOString(),
    revision: copy(context.revision), captures: copy(captures), state: copy(state),
    element: copy(element || null), room: copy(room || null), title: title || '',
    limits: ['A saved view records visible evidence; it does not validate the whole room.',
      ...(!context.revision.parameter_sha256 ? ['Parameter revision is unavailable in this delivery.'] : [])] };
  assertObservationCurrent(observation, context);
  return observation;
}
export function frameState(state, frame) {
  if (!FRAME_NAMES.includes(frame)) throw new Error('Unknown comparison view');
  const next = copy(state);
  next.layers.model = frame !== 'capture';
  next.contextVisible = frame === 'capture' ? false : state.contextVisible;
  for (const key of Object.keys(next.layers)) if (key !== 'model' && frame === 'model') next.layers[key] = false;
  next.opacity.model = frame === 'capture' ? 0 : frame === 'model' ? 1 : state.opacity.model;
  next.opacity.capture = frame === 'model' ? 0 : frame === 'capture' ? 1 : state.opacity.capture;
  return next;
}
export async function captureTriplet(adapter) {
  const original = copy(adapter.read());
  const frames = {};
  try {
    for (const name of FRAME_NAMES) {
      await adapter.apply(frameState(original, name));
      await adapter.settle?.();
      frames[name] = { png: await adapter.snapshot(), camera: copy(adapter.read().camera) };
      if (JSON.stringify(frames[name].camera) !== JSON.stringify(original.camera)) throw new Error('The view moved while saving. Try again.');
    }
    return { state: original, frames };
  } finally { await adapter.apply(original); }
}
export async function replayObservation(observation, context, adapter) {
  assertObservationCurrent(observation, context); // reject stale state before moving anything
  await adapter.apply(copy(observation.state));
  return adapter.read();
}
