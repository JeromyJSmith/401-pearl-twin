// Reviewed starting directions at the model's unchanged qualified standing points.
// Evidence: docs/evidence/runs/calm-room-navigation-20261019/room-starting-heading-selection-v1.json
// These are framing choices, not capture measurements or acceptance of the physical room.
import { directedPose } from './room-transfer.js';
export const REVIEWED_ROOM_YAWS = Object.freeze({
  "099d1949-5da4-5510-981e-55216f6da302": 90,
  "7b8bfc34-d317-5f00-be1e-03badf83aa5c": 270,
  "273e5081-ddfd-5c75-80dd-28898b1449e8": 180,
  "5c214aed-6bf7-537f-97df-3fd677285718": 180,
  "e502dac0-e310-576c-a67d-4e86ab474a58": 90,
  "e59275f6-aca1-59f7-99ed-00bef95f429b": 270,
  "d1246169-7f31-541d-805c-75edace906b0": 270,
  "ee61eeb7-20ec-55d1-b8e6-9e7fab459e27": 270,
  "e190a521-b1a7-5639-afca-d94f68d5a767": 180,
  "cd636813-638c-5ad3-b3af-976c4e7b5525": 180,
  "e3bf16ef-abaa-59cc-a344-a0b20fade4dc": 0,
  "6e83dacb-a131-5d9a-9c5e-a117caff614c": 270,
  "e213e763-e4e6-5ff6-9b94-8f943bbeeb4b": 270,
  "48540d0e-b146-565f-8c48-dc3a3a9718c4": 0,
  "b1194988-29d2-56eb-8328-0fdd91a3ef13": 0,
  "6f98f1fd-138b-5c19-8f9f-4fcf7377921e": 270,
  "b5c90fbc-1aa6-50e3-835e-ea8644889dae": 0,
  "55eb64ff-9ed4-56e8-b518-922971797bc8": 0,
  "a560db59-d3b4-528b-b4da-ee9971b1b3ac": 180,
  "474d0111-4166-5413-8bef-92cdca5bffc2": 90,
  "9b3e560e-052c-5765-a67f-ab83763232d4": 180,
  "489c7cf1-cc4a-530d-8807-a3a559cc3638": 0,
  "de142ae6-db97-5eec-921d-ce85baf7a1d5": 180,
  "283b8854-b297-5abb-a730-c928f5141d21": 180,
  "2cfcb85d-12f4-58a0-9a25-33e98c9a5f85": 0
});
export function applyReviewedRoomHeading(pose, spaceID, status) {
  if (status !== 'SAFE_ROOM' || !Object.hasOwn(REVIEWED_ROOM_YAWS, spaceID)) return pose;
  const yaw = REVIEWED_ROOM_YAWS[spaceID];
  // The explicit eye stays fixed. Only its look direction and derived target change.
  return { ...pose, yaw, t: directedPose(pose.eye, yaw, pose.pitch, pose.fov).t };
}
