// Proxy furniture per room type (the owner's brief: "simple proxy furniture per room type, so every room reads as
// lived in"). These are presentation proxies, not model elements: plain boxes sized to common pieces, placed inside
// the IfcSpace footprint against the wall that faces the camera's stand point. They draw as ink lines while the room
// is still a drawing, hide while the room plays as its scan, and take materials in the proposed pass.

// [kind, width (along the wall), depth, height, colour]
const KIT = {
  sofa: [2.0, 0.9, 0.8, 0x6f6a62], coffee: [1.0, 0.55, 0.42, 0x8a6a4a], chair: [0.75, 0.75, 0.8, 0x7d6f5f],
  bed: [1.5, 2.0, 0.55, 0xd9d2c4], night: [0.45, 0.4, 0.55, 0x8a6a4a],
  counter: [2.4, 0.62, 0.9, 0xc9c2b6], table: [1.2, 0.8, 0.75, 0x8a6a4a], stool: [0.38, 0.38, 0.7, 0x5c5248],
  tub: [1.6, 0.75, 0.55, 0xf2f0ea], toilet: [0.4, 0.65, 0.75, 0xf2f0ea], vanity: [0.8, 0.5, 0.85, 0xe4ddd0],
  shower: [0.85, 0.85, 0.08, 0xf2f0ea], fridge: [0.7, 0.7, 1.8, 0xdedad2], shelf: [0.9, 0.35, 1.9, 0xb9a98f],
  bench: [1.0, 0.38, 0.46, 0x8a6a4a], desk: [1.2, 0.6, 0.75, 0x8a6a4a], wardrobe: [1.2, 0.6, 2.0, 0xcfc6b6],
};

function plan(label) {
  const l = label.toLowerCase();
  if (/front room|living/.test(l)) return [['sofa', 'far'], ['coffee', 'mid'], ['chair', 'side']];
  if (/kitchen/.test(l)) return [['counter', 'far'], ['table', 'mid'], ['stool', 'side']];
  if (/bedroom|room \d$/.test(l)) return [['bed', 'far'], ['night', 'farcorner'], ['wardrobe', 'side']];
  if (/bathroom/.test(l)) return [['tub', 'far'], ['toilet', 'side'], ['vanity', 'near-side']];
  if (/toilet/.test(l)) return [['toilet', 'far'], ['vanity', 'side']];
  if (/shower/.test(l)) return [['shower', 'mid']];
  if (/refrigerator/.test(l)) return [['fridge', 'mid']];
  if (/pantry|closet/.test(l)) return [['shelf', 'far']];
  if (/nook/.test(l)) return [['desk', 'far'], ['chair', 'mid']];
  if (/entry/.test(l)) return [['bench', 'side']];
  return []; // stairs, hallway: kept clear
}

// room: { label, bbox:[u0,v0,u1,v1] house coords, floorZ, i, storey }, stand: [u,v] the camera stand point
export function furnish(room, stand) {
  const [u0, v0, u1, v1] = room.bbox;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const W = u1 - u0, D = v1 - v0;
  // the far wall: the bbox side farthest from the stand point; "side" is the wall to its right
  const dx = cu - stand[0], dy = cv - stand[1];
  const alongU = Math.abs(dx) > Math.abs(dy);
  const sgn = alongU ? Math.sign(dx) || 1 : Math.sign(dy) || 1;
  const pieces = [];
  const inset = 0.06;
  for (const [kind, slot] of plan(room.label)) {
    let [w, d, h, color] = KIT[kind];
    // pieces must fit: shrink to the room, skip if it cannot
    const span = alongU ? D : W, deep = alongU ? W : D;
    if (w > span - 0.2) w = Math.max(0.4, span - 0.2);
    if (d > deep * 0.5) d = deep * 0.5;
    if (w < 0.35 || d < 0.2) continue;
    let pu, pv, ru = w, rv = d; // footprint along u, v
    if (alongU) { ru = d; rv = w; }
    if (slot === 'far' || slot === 'farcorner') {
      if (alongU) { pu = sgn > 0 ? u1 - inset - ru / 2 : u0 + inset + ru / 2; pv = slot === 'farcorner' ? v1 - inset - rv / 2 : cv; }
      else { pv = sgn > 0 ? v1 - inset - rv / 2 : v0 + inset + rv / 2; pu = slot === 'farcorner' ? u1 - inset - ru / 2 : cu; }
      if (slot === 'farcorner' && alongU) pu -= sgn * 0.0;
    } else if (slot === 'mid') {
      pu = cu + (alongU ? sgn * W * 0.08 : 0); pv = cv + (alongU ? 0 : sgn * D * 0.08);
    } else { // side walls
      if (alongU) { [ru, rv] = [w, d]; pv = slot === 'near-side' ? v0 + inset + rv / 2 : v1 - inset - rv / 2; pu = cu + sgn * W * 0.15; }
      else { [ru, rv] = [d, w]; pu = slot === 'near-side' ? u0 + inset + ru / 2 : u1 - inset - ru / 2; pv = cv + sgn * D * 0.15; }
    }
    // keep inside the room
    pu = Math.min(u1 - ru / 2 - inset, Math.max(u0 + ru / 2 + inset, pu));
    pv = Math.min(v1 - rv / 2 - inset, Math.max(v0 + rv / 2 + inset, pv));
    pieces.push({ kind, room: room.i, center: [pu, pv, room.floorZ + h / 2], size: [ru, rv, h], color });
  }
  return pieces;
}
