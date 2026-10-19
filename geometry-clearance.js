// Production safety qualification against the rendered physical model. No model geometry is changed.
// THREE is supplied by the owning presentation's existing import map/runtime.
export function createGeometryClearance({ THREE, meshes, spaces = () => [], clipping = () => ({ cut: 99, phaseCuts: [] }) }) {
  const cache = new WeakMap(), eyeHeight = 1.6, eyeRadius = 0.12, bodyRadius = 0.16;
  const vec = (p) => p?.isVector3 ? p.clone() : new THREE.Vector3(...p);
  function physical() {
    return meshes().filter((m) => m.geometry?.attributes?.position && !['IfcSpace', 'IfcOpeningElement'].includes(m.userData?.e?.cls)).map((mesh) => {
      mesh.updateWorldMatrix(true, false);
      const positions = mesh.geometry.attributes.position, signature = `${mesh.matrixWorld.elements.join(',')}|${positions.version}|${positions.count}|${mesh.geometry.index?.version ?? -1}|${mesh.geometry.index?.count ?? 0}`;
      let entry = cache.get(mesh);
      if (!entry || entry.signature !== signature) {
        const points = Array.from({ length: positions.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld));
        const index = mesh.geometry.index, count = index ? index.count : points.length, triangles = [];
        for (let i = 0; i < count; i += 3) triangles.push([0, 1, 2].map((k) => points[index ? index.getX(i + k) : i + k]));
        const e = mesh.userData?.e || {};
        entry = { signature, mesh, e, id: e.id || mesh.uuid, guid: e.guid || e.global_id || null, phase: mesh.userData?.phase, triangles, box: new THREE.Box3().setFromPoints(points) };
        cache.set(mesh, entry);
      }
      return entry;
    });
  }
  function visible(entry, cuts, point) {
    return point.z <= Math.min(cuts.cut ?? 99, cuts.phaseCuts?.[entry.phase] ?? 99);
  }
  function occupancy(entry, p) {
    if (!entry.box.containsPoint(p)) return false;
    const ray = new THREE.Ray(p, new THREE.Vector3(0.82397, 0.47913, 0.30271).normalize()), out = new THREE.Vector3(), hits = [];
    for (const triangle of entry.triangles) if (ray.intersectTriangle(...triangle, false, out) && out.distanceTo(p) > 1e-7) hits.push(out.distanceTo(p));
    hits.sort((a, b) => a - b);
    return hits.filter((v, i) => !i || v - hits[i - 1] > 1e-6).length % 2 === 1;
  }
  function segmentEdgeDistance(a, b, c, d) {
    const u = b.clone().sub(a), v = d.clone().sub(c), w = a.clone().sub(c);
    const A = u.dot(u), B = u.dot(v), C = v.dot(v), D = u.dot(w), E = v.dot(w), det = A * C - B * B;
    const point = new THREE.Vector3(), ab = new THREE.Line3(a, b), cd = new THREE.Line3(c, d);
    const distance = (p, line, length) => p.distanceToSquared(length > 1e-20 ? line.closestPointToPoint(p, true, point) : line.start);
    let result = Math.min(distance(a, cd, C), distance(b, cd, C), distance(c, ab, A), distance(d, ab, A));
    if (det > 1e-20) {
      const x = (B * E - C * D) / det, y = (A * E - B * D) / det;
      if (x >= 0 && x <= 1 && y >= 0 && y <= 1) result = Math.min(result, w.addScaledVector(u, x).addScaledVector(v, -y).lengthSq());
    }
    return Math.sqrt(Math.max(0, result));
  }
  function collision(eye, { previous = null, radius = eyeRadius, cuts = clipping(), fullGeometry = false } = {}) {
    const p = vec(eye), from = previous ? vec(previous) : p.clone(), path = p.clone().sub(from), length = path.length();
    const query = new THREE.Box3().setFromPoints([from, p]).expandByScalar(radius), contacts = [], closest = new THREE.Vector3(), hit = new THREE.Vector3();
    const steps = Math.max(1, Math.ceil(length / Math.max(0.02, radius / 3)));
    for (const e of physical()) {
      if (!query.intersectsBox(e.box) || (!fullGeometry && !e.mesh.visible)) continue;
      const actualCuts = fullGeometry ? { cut: 99, phaseCuts: [] } : cuts;
      let reason = null, clearance = Infinity, hitPoint = null;
      if (visible(e, actualCuts, p) && occupancy(e, p)) { reason = 'EYE_INSIDE_PHYSICAL_SOLID'; clearance = 0; hitPoint = p.toArray(); }
      const cut = Math.min(actualCuts.cut ?? 99, actualCuts.phaseCuts?.[e.phase] ?? 99);
      for (const raw of e.triangles) {
        const polygon = [];
        for (let i = 0; i < 3; i++) {
          const a = raw[i], b = raw[(i + 1) % 3], ain = a.z <= cut, bin = b.z <= cut;
          if (ain) polygon.push(a);
          if (ain !== bin) { const p = a.clone().lerp(b, (cut - a.z) / (b.z - a.z)); p.z = cut; polygon.push(p); }
        }
        for (let j = 1; j + 1 < polygon.length; j++) {
          const triangle = [polygon[0], polygon[j], polygon[j + 1]], face = new THREE.Triangle(...triangle);
          for (let step = 0; step <= steps; step++) {
            const point = from.clone().lerp(p, step / steps);
            face.closestPointToPoint(point, closest);
            const distance = closest.distanceTo(point);
            if (distance < clearance) { clearance = distance; if (distance < radius - 1e-5) { reason ||= 'EYE_CLEARANCE'; hitPoint = closest.toArray(); } }
          }
          if (length > 1e-7) {
            for (let edge = 0; edge < 3; edge++) {
              const distance = segmentEdgeDistance(from, p, triangle[edge], triangle[(edge + 1) % 3]);
              if (distance < clearance) { clearance = distance; if (distance < radius - 1e-5) { reason ||= 'EYE_CLEARANCE'; hitPoint = null; } }
            }
            const ray = new THREE.Ray(from, path.clone().normalize());
            if (ray.intersectTriangle(...triangle, false, hit) && hit.distanceTo(from) < length - 1e-7 && hit.distanceTo(from) > 1e-7) { reason = 'CAMERA_SEGMENT_CROSSES_VISIBLE_FACE'; hitPoint = hit.toArray(); clearance = 0; }
          }
        }
      }
      if (reason) contacts.push({ elementID: e.id, ifcGUID: e.guid, name: e.e.name, cls: e.e.cls, reason, clearance_m: clearance, hitPoint });
    }
    return contacts;
  }
  function bodyCollision(eye, { previous = null, floorZ = vec(eye).z - eyeHeight, cuts = clipping(), fullGeometry = false } = {}) {
    const top = vec(eye), start = previous ? vec(previous) : top.clone(), travel = top.distanceTo(start);
    const steps = Math.max(1, Math.ceil(travel / 0.02)), margin = travel / steps / 2;
    const contacts = collision(top, { previous: start, radius: eyeRadius, cuts, fullGeometry });
    for (let i = 0; i <= steps; i++) {
      const columnTop = start.clone().lerp(top, i / steps);
      // Interpolate the standing floor with the supplied eye's vertical movement; no independent floor is invented.
      const bottom = new THREE.Vector3(columnTop.x, columnTop.y, floorZ + columnTop.z - top.z + 0.18);
      contacts.push(...collision(columnTop, { previous: bottom, radius: bodyRadius + margin, cuts, fullGeometry }));
    }
    return [...new Map(contacts.map((c) => [c.elementID, c])).values()];
  }
  function inside(point, polygon) {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
    }
    return result;
  }
  function boundaryDistance(p, polygon) {
    const query = new THREE.Vector3(p[0], p[1], 0), out = new THREE.Vector3();
    return Math.min(...polygon.map((a, i) => { const line = new THREE.Line3(new THREE.Vector3(...a, 0), new THREE.Vector3(...polygon[(i + 1) % polygon.length], 0)); return line.distanceSq() > 1e-20 ? line.closestPointToPoint(query, true, out).distanceTo(query) : line.start.distanceTo(query); }));
  }
  function floorAt(x, y, expected) {
    const ray = new THREE.Ray(new THREE.Vector3(x, y, expected + 0.27), new THREE.Vector3(0, 0, -1)), out = new THREE.Vector3(), normal = new THREE.Vector3(), hits = [], testedElements = [];
    for (const e of physical()) {
      if (!['IfcSlab', 'IfcStairFlight', 'IfcStair', 'IfcCovering'].includes(e.e.cls) || x < e.box.min.x || x > e.box.max.x || y < e.box.min.y || y > e.box.max.y) continue;
      testedElements.push({ elementID: e.id, ifcGUID: e.guid });
      for (const triangle of e.triangles) {
        if (new THREE.Triangle(...triangle).getNormal(normal).z < 0.7) continue;
        if (ray.intersectTriangle(...triangle, false, out) && Math.abs(out.z - expected) <= 0.25) hits.push({ elementID: e.id, ifcGUID: e.guid, z: out.z, name: e.e.name, distanceFromDeclaredFloor_m: Math.abs(out.z - expected) });
      }
    }
    hits.sort((a, b) => a.distanceFromDeclaredFloor_m - b.distanceFromDeclaredFloor_m);
    return { hit: hits[0] || null, evidence: { origin: ray.origin.toArray(), direction: [0, 0, -1], expectedFloorZ: expected, acceptedFloorWindow_m: [expected - 0.25, expected + 0.25], testedElements, hits } };
  }
  function target(room, preferredEye = null) {
    const polygon = room.poly, expected = room.floorZ ?? room.s?.floor_z, identity = { key: room.name || room.s?.name, spaceID: room.s?.id || room.id, storey: room.storey, apartment: room.apt };
    if (!Array.isArray(polygon) || polygon.length < 3 || !Number.isFinite(expected)) throw new Error(`Real room polygon/floor required: ${identity.spaceID}`);
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]), lo = [Math.min(...xs), Math.min(...ys)], hi = [Math.max(...xs), Math.max(...ys)], candidates = [];
    const add = (x, y, preferred = false) => { if (inside([x, y], polygon)) candidates.push({ x, y, preferred, distance: boundaryDistance([x, y], polygon) }); };
    if (preferredEye) { const p = vec(preferredEye); add(p.x, p.y, true); }
    add((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2);
    for (let i = 1; i < 9; i++) for (let j = 1; j < 9; j++) add(lo[0] + (hi[0] - lo[0]) * i / 9, lo[1] + (hi[1] - lo[1]) * j / 9);
    candidates.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.distance - a.distance);
    const blockers = new Map(), unsupported = [], floorRays = [];
    for (const candidate of candidates) {
      const probe = floorAt(candidate.x, candidate.y, expected), floor = probe.hit; floorRays.push(probe.evidence);
      if (!floor) { unsupported.push([candidate.x, candidate.y]); continue; }
      const eye = [candidate.x, candidate.y, floor.z + eyeHeight];
      const contacts = bodyCollision(eye, { floorZ: floor.z, fullGeometry: true });
      if (!contacts.length) return { ...identity, status: 'SAFE_ROOM', eye, floorZ: floor.z, actualFloor: floor, floorRay: probe.evidence, eyeHeight_m: eyeHeight, bodyRadius_m: bodyRadius, eyeRadius_m: eyeRadius, blockedElementIDs: [], blockedIFCGUIDs: [], blockers: [], reason: 'ACTUAL_ROOM_FLOOR_AND_FULL_GEOMETRY_CLEARANCE' };
      for (const contact of contacts) blockers.set(contact.elementID, contact);
    }
    const relevant = physical().filter((e) => e.box.max.x >= lo[0] && e.box.min.x <= hi[0] && e.box.max.y >= lo[1] && e.box.min.y <= hi[1]);
    // Missing support is explicit; a referenced slab is evidence of the tested region, not an invented obstacle face.
    const supportEvidence = relevant.filter((e) => ['IfcSlab', 'IfcStairFlight', 'IfcStair', 'IfcCovering'].includes(e.e.cls)).map((e) => ({ elementID: e.id, ifcGUID: e.guid, reason: 'NO_UPWARD_SUPPORT_FACE_WITHIN_250MM_OF_DECLARED_ROOM_FLOOR' }));
    return { ...identity, status: 'BLOCKED_OVERHEAD_ONLY', eye: null, floorZ: expected, actualFloor: null, blockedElementIDs: [...blockers.keys()], blockedIFCGUIDs: [...new Set([...blockers.values()].map((b) => b.ifcGUID).filter(Boolean))], blockers: [...blockers.values()], supportEvidence, floorRays, candidatesTested: candidates.length, unsupportedCandidateCount: unsupported.length, reason: blockers.size ? 'NO_ROOM_TARGET_WITH_FULL_BODY_AND_EYE_CLEARANCE' : 'NO_ACTUAL_FLOOR_SUPPORT_AT_CANDIDATE_ROOM_POINTS' };
  }
  return {
    collision, bodyCollision, target,
    refresh() { return physical().length; },
    meshMetadata() { return physical().map((e) => ({ id: e.id, ifcGUID: e.guid, phase: e.phase, visible: e.mesh.visible })); },
    allTargets() { return spaces().map((room) => target(room)); },
  };
}
