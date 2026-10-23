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
  sofa3: [1.6, 0.7, 0.8, 0x8b8178], dchair: [0.5, 0.52, 0.85, 0x8a6a4a], console: [1.1, 0.4, 0.8, 0x8a6a4a],
  tv: [1.42, 0.06, 0.82, 0x121314], rug: [2.4, 1.8, 0.012, 0x9c4f36], credenza: [1.8, 0.38, 0.5, 0x8a6a4a],
  barstool: [0.48, 0.48, 0.75, 0x5c5248], cab: [1.0, 0.62, 0.92, 0x2e4440], sinkrun: [1.9, 0.62, 0.92, 0x2e4440],
  range: [0.91, 0.74, 0.92, 0xbfc3c5], bed2: [1.6, 2.1, 1.15, 0xd9d2c4], night2: [0.5, 0.4, 0.55, 0x5b3b26],
  dresser: [1.14, 0.49, 1.88, 0x8a6a4a], vanity2: [0.75, 0.46, 0.85, 0x5b3b26], showerkit: [1.0, 0.12, 2.1, 0xece8e1],
  kitB: [1.0, 0.6, 0.92, 0x1f2b3d], doorleaf: [0.9, 0.045, 2.03, 0x4a6872], builtin: [0.88, 0.22, 2.04, 0xf2f0ea], minisplit: [0.8, 0.22, 0.3, 0xf4f4f2],
  fan: [1.3, 1.3, 0.3, 0xf4f4f2], heater: [0.5, 0.09, 0.62, 0xf4f4f2], curtain: [1.1, 0.06, 2.3, 0xf3f0ea], plank: [1, 1, 0.008, 0x8a7b6a],
  bistro: [0.75, 0.75, 0.74, 0x5b3b26],
  lounge: [1.0, 1.19, 1.17, 0x7d6f5f], marble: [1, 1, 0.008, 0xf1f2f3], tub: [1.7, 0.8, 0.6, 0xf4f3ef],
  laundry: [1.3, 0.66, 0.92, 0xeeeeec], wetbar: [1.5, 0.58, 0.92, 0x2e4440], art: [0.59, 0.03, 0.84, 0x8a6a4a], sidetable: [0.55, 0.45, 0.55, 0x8a6a4a], plant: [0.59, 0.63, 1.35, 0x557a46], fridge2: [0.86, 0.62, 2.13, 0xbfc3c5], pocketdoor: [0.76, 0.035, 2.0, 0xf1eee8],
};
// pieces hung on the wall: centre height above the floor (the TV's bottom edge about 0.94 m up, clear of the credenza)
const MOUNT = { tv: 1.35, art: 1.5 };

function plan(label) {
  const l = label.toLowerCase();
  // each room its own pieces (owner 2026-10-23: the front room and the living area must not read as copies)
  if (/front room/.test(l)) return [['sofa', 'far'], ['coffee', 'mid'], ['chair', 'side']];
  // owner 2026-10-23: a big TV on the east wall (Apartment A wall 07), the couch on the window wall facing it; the far
  // side is the open passage to the kitchen and stays clear
  if (/living/.test(l)) return [['sofa3', 'near-side-tv'], ['tv', 'side-tv']];
  if (/kitchen/.test(l)) return [['counter', 'far'], ['table', 'mid'], ['dchair', 'side'], ['stool', 'near-side']];
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

// Rooms laid out by hand (owner 2026-10-23, second pass: "imagine where it would go and make it look high end").
// A piece here carries `face`, the plan direction its front looks to, so it sits square to its wall instead of turning
// toward the room centre; `free` pieces (stools tucked under the bar) may reach past the IfcSpace edge.
const piece = (room, kind, u, v, su, sv, face, extra = {}) => {
  const h = KIT[kind][2];
  return { kind, room: room.i, center: [u, v, room.floorZ + (MOUNT[kind] ?? h / 2)], size: [su, sv, h], color: KIT[kind][3], face, ...extra };
};
// the room's extent along u on the line v (its polygon crossed by a horizontal line): walls jog, the bbox does not
const span = (poly, v) => {
  const xs = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ui, vi] = poly[i], [uj, vj] = poly[j];
    if ((vi > v) !== (vj > v)) xs.push(ui + ((v - vi) * (uj - ui)) / (vj - vi));
  }
  return [Math.min(...xs), Math.max(...xs)];
};
const LAYOUT = {
  // Apartment A living area: the couch square on the west wall, its back to window W-W1, a rug and coffee table in
  // front, the TV across on wall 07 over a low credenza, three bar stools along the bar (the half wall on the north edge)
  'AptA - Living area': (r) => {
    const [u0, v0, u1, v1] = r.bbox, sv = v1 - 1.75; // the seating group's centre line, clear of the stools
    return [
      piece(r, 'rug', u0 + 1.45, sv, 1.8, 2.4, [1, 0]),
      piece(r, 'sofa3', u0 + 0.03 + 0.33, sv, 0.66, 1.6, [1, 0]),
      piece(r, 'coffee', u0 + 1.5, sv, 0.6, 1.2, [0, -1]),
      piece(r, 'credenza', u1 - 0.03 - 0.19, sv, 0.38, 1.8, [-1, 0]),
      piece(r, 'tv', u1 - 0.06, sv, 0.06, 1.42, [-1, 0], { free: true }),
      ...[0.55, 1.25, 1.95].map((k) => piece(r, 'barstool', u1 - k, v1 - 0.17, 0.48, 0.48, [0, 1], { free: true })),
    ];
  },
  // Apartment A kitchen (owner 2026-10-23: "the kitchen is where the food is cooked"; no table). The north wall: base
  // cabinets wall to wall with the sink centred under window N-W1 and upper cupboards either side of it. The half wall
  // under the bar: a 36-inch pro range (0.91 m) between two base cabinets, under an island hood, so the cook faces the
  // bar stools and serves across the bar.
  'AptA - Kitchen w/ bar': (r) => {
    const [, v0, , v1] = r.bbox, cv = v1 - 0.03 - 0.31, ceil = r.height || 2.7;
    const [a, b] = span(r.poly, cv), run = b - a - 0.06, su = (a + b) / 2;
    const win = [-5.15, -3.25]; // N-W1 (horizontal slider), u extents in the house frame
    const hw = [-4.63, -2.24], hv = v0; // the half wall's u extents; its kitchen face is the room's south edge
    const ru = (hw[0] + hw[1]) / 2, side = (hw[1] - hw[0] - 0.91) / 2;
    return [
      piece(r, 'sinkrun', su, cv, run, 0.62, [0, -1], { sinkAt: (win[0] + win[1]) / 2 - su, window: [win[0] - su, win[1] - su] }),
      piece(r, 'range', ru, hv + 0.37, 0.91, 0.74, [0, 1], { ceil, free: true }), // backs onto the room's edge
      piece(r, 'cab', hw[0] + side / 2, hv + 0.31, side, 0.62, [0, 1], { free: true }),
      piece(r, 'cab', hw[1] - side / 2, hv + 0.31, side, 0.62, [0, 1], { free: true }),
      // the pantry's 30-inch pocket door in wall 06 (doorway v 3.62..4.38, opening-params.json, owner 2026-10-23),
      // slid almost all the way into its pocket: only the leading edge with its pull shows
      piece(r, 'pocketdoor', -2.505, 4.38 - 0.15 + 0.38, 0.035, 0.76, [-1, 0], { free: true }),
    ];
  },
  // the upper floor (owner 2026-10-23, checkpoint 3): attic rooms under the main gable, flat ceilings at about 2.2 m.
  // Each bedroom: an upholstered bed with its head on a wall, nightstands with lamps where there is room, a wool rug.
  // Room 1 is the upstairs bathroom (owner 2026-10-23): a freestanding tub in the south-east corner against the hall
  // wall, the washer and dryer in the south-west nook, the wet bar straight across on the north wall backing onto the
  // toilet room, a small closet behind the east knee wall (wall 18, rebuilt with its door); the floor long white
  // marble tiles with blue veining, as in the toilet room and the shower
  'Upper - Room 1': (r) => [
    piece(r, 'marble', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true }),
    piece(r, 'tub', -0.663 - 0.05 - 0.85, -1.41 + 0.04 + 0.4, 1.7, 0.8, [0, 1], { free: true }), // its east end sits on the room outline's corner
    piece(r, 'laundry', -4.75, -2.23 + 0.03 + 0.33, 1.3, 0.66, [0, 1]),
    piece(r, 'wetbar', -4.65, 0.59 - 0.03 - 0.29, 1.5, 0.58, [0, -1]),
  ],
  'Upper - Room 2': (r) => [ // bed on the west knee wall, a lounge chair by the south gable window S-U1
    piece(r, 'rug', -4.2, -4.3, 1.9, 2.4, [1, 0], { palette: 'ink' }),
    piece(r, 'bed2', -5.55 + 0.03 + 1.05, -4.3, 2.1, 1.6, [1, 0], { headboard: 0x46525a, throw: 0xc29a4b }),
    piece(r, 'night2', -5.55 + 0.03 + 0.2, -4.3 + 1.1, 0.4, 0.5, [1, 0]),
    piece(r, 'night2', -5.55 + 0.03 + 0.2, -4.3 - 1.1, 0.4, 0.5, [1, 0]),
    piece(r, 'lounge', -2.65, -5.45, 1.19, 1.0, [-0.6, 0.8]),
    piece(r, 'plant', -2.25, -5.75, 0.59, 0.63, [-1, 0]),
  ],
  'Upper - Room 3': (r) => [ // bed on the east wall under the high window E-U1, a chest of drawers on the south wall
    piece(r, 'rug', 2.1, -3.2, 1.9, 2.4, [-1, 0], { palette: 'rust' }),
    piece(r, 'bed2', 3.47 - 0.03 - 1.05, -3.2, 2.1, 1.6, [-1, 0], { headboard: 0x7a8b78, throw: 0x9c4f36 }),
    piece(r, 'night2', 3.47 - 0.03 - 0.2, -3.2 + 1.1, 0.4, 0.5, [-1, 0]),
    piece(r, 'night2', 3.47 - 0.03 - 0.2, -3.2 - 1.1, 0.4, 0.5, [-1, 0]),
    piece(r, 'dresser', 0.8, -4.93 + 0.03 + 0.25, 1.14, 0.49, [0, 1]),
  ],
  'Upper - Hallway': (r) => [piece(r, 'rug', -2.45, -1.85, 2.6, 0.75, [0, 1], { palette: 'rust' }),
    piece(r, 'art', -1.45, -1.48 - 0.02, 0.59, 0.03, [0, -1], { free: true })], // a framed print on the wall the hall hold faces
  // the upper toilet (the model has the WC): a floating walnut vanity with a basin and mirror at the east end
  'Upper - Toilet': (r) => [piece(r, 'marble', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true }), piece(r, 'vanity2', -4.25, 1.63 - 0.03 - 0.23, 0.75, 0.46, [0, -1])],
  // the upper shower (the model has the tray): tile and a brass rain column on its north wall
  'Upper - Shower': (r) => [piece(r, 'marble', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true }), piece(r, 'showerkit', -0.84, 1.66 - 0.03 - 0.06, 1.0, 0.12, [0, -1], { free: true })],
  // Apartment B as captured (owner 2026-10-23: "look at it and design it"; the 360 splat aptb_360_20261019, placed on the
  // Polycam of the same rooms): grey-brown plank floors, a navy shaker kitchen with butcher block, mini-splits, a ceiling
  // fan. Loose furniture stays out except the bedroom's bed (owner 2026-10-23: he will make his own examples; keep what
  // is actually there). Positions of modelled elements are their extents in the house frame.
  'AptB - Front Room': (r) => [
    piece(r, 'plank', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true }),
    piece(r, 'builtin', -0.31, -2.15, 0.22, 0.88, [1, 0], { free: true }), // the inset bookshelf, white as captured
    piece(r, 'minisplit', -0.44 + 0.03 + 0.11, -1.75, 0.22, 0.8, [1, 0], { free: true, z: 2.18 }),
    piece(r, 'fan', 1.55, -3.85, 1.3, 1.3, [0, -1], { free: true, ceil: r.height }),
    piece(r, 'heater', -0.44 + 0.03 + 0.045, -4.7, 0.09, 0.5, [1, 0], { free: true }),
    piece(r, 'curtain', 2.41, -6.36 + 0.07, 1.1, 0.06, [0, 1], { free: true }), // sheer over south window S-W2
    // the front door S-D2 as captured: painted blue-teal inside (splat #354754..#3c5458, lifted for the lit material),
    // half glass over a braced panel, standing open into the room on its west hinge (the model's leaf sits 0.4 m west of the opening)
    piece(r, 'doorleaf', 0.45 + 0.025, -6.38 + 0.43, 0.045, 0.86, [1, 0], { free: true, color: 0x4a6872 }), // on the west jamb of the opening u 0.45..1.33
  ],
  'AptB - Kitchen': (r) => [ // the modelled runs, restyled: north sink run with uppers and shelves, south run with the cooktop
    piece(r, 'plank', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true }),
    piece(r, 'kitB', 1.285, 1.12, 2.19, 0.6, [0, -1], { free: true, sinkAt: 1.27 - 1.285, uppers: [[-1.095, -0.53], [0.55, 1.095]], shelves: [-0.53, 0.55], round: 1 }),
    piece(r, 'kitB', 2.515, -0.97, 1.89, 0.6, [0, 1], { free: true, cooktopAt: 2.52 - 2.515 }),
    piece(r, 'kitB', -0.08, -0.74, 1.06, 0.58, [1, 0], { free: true }),
  ],
  'AptB - Nook': (r) => [
    piece(r, 'plank', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true }),
    piece(r, 'minisplit', -2.24 + 0.03 + 0.11, 0.2, 0.22, 0.8, [1, 0], { free: true, z: 2.18 }),
  ],
  'AptB - Bedroom': (r) => [
    piece(r, 'plank', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true }),
    piece(r, 'bed2', 2.1, 5.37 - 0.03 - 1.05, 1.6, 2.1, [0, -1], { headboard: 0x6d5a4a, throw: 0x38465a }),
  ],
  // the bathroom keeps its modelled fixtures (toilet, vanity, tray, washer, dryer): the shower wall tiled as captured
  'AptB - Shower Area': (r) => [piece(r, 'marble', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true, tex: 'hex' }), piece(r, 'showerkit', -0.5, 5.37 - 0.03 - 0.06, 1.9, 0.12, [0, -1], { free: true })],
  'AptB - Toilet Area': (r) => [piece(r, 'marble', r.cu, r.cv, r.w, r.d, [0, -1], { poly: r.poly, free: true, tex: 'hex' })],
  'AptB - Bathroom': () => [],
  // the refrigerator nook (it opens west into the kitchen): one built-in column, floor to ceiling, filling the nook
  'AptA - Refrigerator': (r) => {
    const [u0, v0, u1, v1] = r.bbox;
    return [piece(r, 'fridge2', (u0 + u1) / 2, (v0 + v1) / 2, u1 - u0 - 0.02, v1 - v0 - 0.02, [-1, 0], { ceil: r.height || 2.6, free: true })];
  },
};

// room: { name, label, bbox:[u0,v0,u1,v1] house coords, floorZ, i, storey }, stand: [u,v] the camera stand point
export function furnish(room, stand) {
  if (LAYOUT[room.name]) return LAYOUT[room.name](room);
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
    if (w < 0.35 || (d < 0.2 && !MOUNT[kind])) continue; // wall-hung pieces (a TV) are thin
    let pu, pv, ru = w, rv = d; // footprint along u, v
    if (alongU) { ru = d; rv = w; }
    if (slot === 'far' || slot === 'farcorner') {
      if (alongU) { pu = sgn > 0 ? u1 - inset - ru / 2 : u0 + inset + ru / 2; pv = slot === 'farcorner' ? v1 - inset - rv / 2 : cv; }
      else { pv = sgn > 0 ? v1 - inset - rv / 2 : v0 + inset + rv / 2; pu = slot === 'farcorner' ? u1 - inset - ru / 2 : cu; }
      if (slot === 'farcorner' && alongU) pu -= sgn * 0.0;
    } else if (slot === 'mid') {
      pu = cu + (alongU ? sgn * W * 0.08 : 0); pv = cv + (alongU ? 0 : sgn * D * 0.08);
    } else { // side walls; the -tv slots sit further along, across from each other (the TV and the couch facing it)
      const near = slot.startsWith('near-side'), along = slot.endsWith('-tv') ? 0.35 : 0.15;
      if (alongU) { [ru, rv] = [w, d]; pv = near ? v0 + inset + rv / 2 : v1 - inset - rv / 2; pu = cu + sgn * W * along; }
      else { [ru, rv] = [d, w]; pu = near ? u0 + inset + ru / 2 : u1 - inset - ru / 2; pv = cv + sgn * D * along; }
    }
    // keep inside the room
    pu = Math.min(u1 - ru / 2 - inset, Math.max(u0 + ru / 2 + inset, pu));
    pv = Math.min(v1 - rv / 2 - inset, Math.max(v0 + rv / 2 + inset, pv));
    pieces.push({ kind, room: room.i, center: [pu, pv, room.floorZ + (MOUNT[kind] ?? h / 2)], size: [ru, rv, h], color });
  }
  return pieces;
}
