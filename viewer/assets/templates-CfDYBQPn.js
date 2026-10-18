import{t as e}from"./cost-tree-5gZ3rhkS.js";var t=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Data Quality Audit ──────────────────────────────────────────────────
// Stakeholder: BIM Manager / QA
//
// Scans every entity in the model for data completeness issues that would
// take hours to find by clicking through the UI. Produces a scorecard,
// color-codes the 3D view by quality level, and exports an issues CSV.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()
const all = bim.query.all()
if (all.length === 0) { console.error('No entities loaded'); throw new Error('empty model') }

// ── 1. Check every entity for missing attributes ────────────────────────
interface Issue { entity: BimEntity; field: string }
const issues: Issue[] = []
const scores: Record<string, { entity: BimEntity; score: number }> = {}

// Track property coverage per type
const typePsetCoverage: Record<string, { total: number; withPsets: number }> = {}

for (const e of all) {
  let score = 0
  const maxScore = 5 // Name, Description, ObjectType, has properties, has quantities

  if (e.Name && e.Name !== '') score++
  else issues.push({ entity: e, field: 'Name' })

  if (e.Description && e.Description !== '') score++
  else issues.push({ entity: e, field: 'Description' })

  if (e.ObjectType && e.ObjectType !== '') score++
  else issues.push({ entity: e, field: 'ObjectType' })

  const psets = bim.query.properties(e)
  if (psets.length > 0) score++
  else issues.push({ entity: e, field: 'PropertySets' })

  const qsets = bim.query.quantities(e)
  if (qsets.length > 0) score++
  else issues.push({ entity: e, field: 'Quantities' })

  scores[e.GlobalId] = { entity: e, score }

  // Track pset coverage per type
  if (!typePsetCoverage[e.Type]) typePsetCoverage[e.Type] = { total: 0, withPsets: 0 }
  typePsetCoverage[e.Type].total++
  if (psets.length > 0) typePsetCoverage[e.Type].withPsets++
}

// ── 2. Classify entities by quality tier ────────────────────────────────
const tiers = { complete: [] as BimEntity[], good: [] as BimEntity[], partial: [] as BimEntity[], poor: [] as BimEntity[] }
for (const { entity, score } of Object.values(scores)) {
  if (score === 5) tiers.complete.push(entity)
  else if (score >= 4) tiers.good.push(entity)
  else if (score >= 2) tiers.partial.push(entity)
  else tiers.poor.push(entity)
}

// ── 3. Color-code by quality ────────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (tiers.complete.length > 0) batches.push({ entities: tiers.complete, color: '#27ae60' }) // green
if (tiers.good.length > 0) batches.push({ entities: tiers.good, color: '#f1c40f' })    // yellow
if (tiers.partial.length > 0) batches.push({ entities: tiers.partial, color: '#e67e22' }) // orange
if (tiers.poor.length > 0) batches.push({ entities: tiers.poor, color: '#e74c3c' })    // red
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// ── 4. Report ───────────────────────────────────────────────────────────
const overallScore = ((tiers.complete.length + tiers.good.length * 0.8 + tiers.partial.length * 0.4) / all.length * 100)
console.log('═══════════════════════════════════════')
console.log('  DATA QUALITY AUDIT')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Overall score: ' + overallScore.toFixed(1) + '% (' + all.length + ' entities)')
console.log('')
console.log('  Complete (5/5): ' + tiers.complete.length + '  ● green')
console.log('  Good     (4/5): ' + tiers.good.length + '  ● yellow')
console.log('  Partial  (2-3): ' + tiers.partial.length + '  ● orange')
console.log('  Poor     (0-1): ' + tiers.poor.length + '  ● red')

// ── 5. Issue breakdown by field ─────────────────────────────────────────
const issuesByField: Record<string, number> = {}
for (const issue of issues) {
  issuesByField[issue.field] = (issuesByField[issue.field] || 0) + 1
}
console.log('')
console.log('── Missing Data Breakdown ──')
for (const [field, count] of Object.entries(issuesByField).sort((a, b) => b[1] - a[1])) {
  const pct = (count / all.length * 100).toFixed(1)
  console.log('  ' + field + ': ' + count + ' entities (' + pct + '% missing)')
}

// ── 6. Property coverage per type ───────────────────────────────────────
console.log('')
console.log('── Property Coverage by Type ──')
const coverageSorted = Object.entries(typePsetCoverage)
  .sort((a, b) => b[1].total - a[1].total)
  .slice(0, 15)
for (const [type, cov] of coverageSorted) {
  const pct = (cov.withPsets / cov.total * 100).toFixed(0)
  const bar = '█'.repeat(Math.round(cov.withPsets / cov.total * 20))
  console.log('  ' + type + ': ' + bar + ' ' + pct + '% (' + cov.withPsets + '/' + cov.total + ')')
}

// ── 7. Worst offenders (first 10 entities with score 0-1) ──────────────
if (tiers.poor.length > 0) {
  console.log('')
  console.log('── Worst Offenders (score 0-1) ──')
  for (const e of tiers.poor.slice(0, 10)) {
    console.log('  ' + (e.Name || '<no name>') + ' [' + e.Type + '] GlobalId=' + e.GlobalId)
  }
  if (tiers.poor.length > 10) {
    console.log('  ... and ' + (tiers.poor.length - 10) + ' more')
  }
}

// ── 8. Export all entities with discovered property/quantity data ────────
// Discover common property columns from a sample
const sampleForDiscovery = all.slice(0, 200)
const discoveredPropPaths = new Set<string>()
const discoveredQtyPaths = new Set<string>()
for (const e of sampleForDiscovery) {
  const psets = bim.query.properties(e)
  for (const pset of psets) {
    for (const p of pset.properties) {
      if (p.value !== null && p.value !== '') {
        discoveredPropPaths.add(pset.name + '.' + p.name)
      }
    }
  }
  const qsets = bim.query.quantities(e)
  for (const qset of qsets) {
    for (const q of qset.quantities) {
      if (q.value !== null && q.value !== 0) {
        discoveredQtyPaths.add(qset.name + '.' + q.name)
      }
    }
  }
}
// Cap columns to keep CSV manageable
const auditPropCols = Array.from(discoveredPropPaths).sort().slice(0, 20)
const auditQtyCols = Array.from(discoveredQtyPaths).sort().slice(0, 10)
bim.export.csv(all, {
  columns: ['Name', 'Type', 'GlobalId', 'Description', 'ObjectType', ...auditPropCols, ...auditQtyCols],
  filename: 'data-quality-audit.csv'
})
console.log('')
console.log('Exported ' + all.length + ' entities (' + (5 + auditPropCols.length + auditQtyCols.length) + ' columns) to data-quality-audit.csv')
`,n=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Fire Safety Compliance Check ────────────────────────────────────────
// Stakeholder: Architect / Fire Safety Engineer
//
// Cross-references fire rating properties across walls and doors — a task
// that requires clicking through hundreds of entities in the properties
// panel. The script checks Pset_WallCommon.FireRating and
// Pset_DoorCommon.FireRating, flags missing or non-compliant values,
// color-codes the model by compliance status, and generates a report.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()

// ── 1. Gather fire-rated element types ──────────────────────────────────
const walls = bim.query.byType('IfcWall', 'IfcWallStandardCase')
const doors = bim.query.byType('IfcDoor', 'IfcDoorStandardCase')
const slabs = bim.query.byType('IfcSlab')
const total = walls.length + doors.length + slabs.length

if (total === 0) {
  console.error('No walls, doors, or slabs found in model')
  throw new Error('no elements')
}

// ── 2. Extract fire rating from properties ──────────────────────────────
interface FireResult {
  entity: BimEntity
  rating: string | null
  isLoadBearing: boolean | null
  isExternal: boolean | null
}

// Collect fire-related property paths for CSV export
const firePropPaths = new Set<string>()

function extractFireData(entity: BimEntity): FireResult {
  const result: FireResult = { entity, rating: null, isLoadBearing: null, isExternal: null }
  const psets = bim.query.properties(entity)
  for (const pset of psets) {
    for (const p of pset.properties) {
      const lower = p.name.toLowerCase()
      if (lower === 'firerating' && p.value !== null && p.value !== '') {
        result.rating = String(p.value)
        firePropPaths.add(pset.name + '.FireRating')
      }
      if (lower === 'loadbearing' && p.value !== null) {
        result.isLoadBearing = p.value === true || p.value === 'TRUE' || p.value === '.T.'
        firePropPaths.add(pset.name + '.LoadBearing')
      }
      if (lower === 'isexternal' && p.value !== null) {
        result.isExternal = p.value === true || p.value === 'TRUE' || p.value === '.T.'
        firePropPaths.add(pset.name + '.IsExternal')
      }
    }
  }
  return result
}

// ── 3. Analyze each element category ────────────────────────────────────
const wallResults = walls.map(extractFireData)
const doorResults = doors.map(extractFireData)
const slabResults = slabs.map(extractFireData)

// Classify
const rated: BimEntity[] = []
const unrated: BimEntity[] = []
const loadBearingUnrated: BimEntity[] = []
const externalUnrated: BimEntity[] = []

for (const r of [...wallResults, ...doorResults, ...slabResults]) {
  if (r.rating) {
    rated.push(r.entity)
  } else {
    unrated.push(r.entity)
    if (r.isLoadBearing) loadBearingUnrated.push(r.entity)
    if (r.isExternal) externalUnrated.push(r.entity)
  }
}

// ── 4. Group by fire rating value ───────────────────────────────────────
const ratingGroups: Record<string, BimEntity[]> = {}
for (const r of [...wallResults, ...doorResults, ...slabResults]) {
  if (r.rating) {
    if (!ratingGroups[r.rating]) ratingGroups[r.rating] = []
    ratingGroups[r.rating].push(r.entity)
  }
}

// ── 5. Color-code by compliance ─────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (rated.length > 0) batches.push({ entities: rated, color: '#27ae60' })           // green = rated
if (loadBearingUnrated.length > 0) batches.push({ entities: loadBearingUnrated, color: '#e74c3c' }) // red = critical
if (externalUnrated.length > 0) batches.push({ entities: externalUnrated, color: '#e67e22' })       // orange = warning
// Remaining unrated that are not load-bearing or external
const otherUnrated = unrated.filter(e => {
  const isLB = loadBearingUnrated.some(lb => lb.GlobalId === e.GlobalId)
  const isExt = externalUnrated.some(ext => ext.GlobalId === e.GlobalId)
  return !isLB && !isExt
})
if (otherUnrated.length > 0) batches.push({ entities: otherUnrated, color: '#f1c40f' }) // yellow = missing
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// ── 6. Report ───────────────────────────────────────────────────────────
const compliancePct = (rated.length / total * 100).toFixed(1)
console.log('═══════════════════════════════════════')
console.log('  FIRE SAFETY COMPLIANCE CHECK')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Scanned: ' + walls.length + ' walls, ' + doors.length + ' doors, ' + slabs.length + ' slabs')
console.log('Compliance: ' + compliancePct + '% (' + rated.length + '/' + total + ' rated)')
console.log('')
console.log('  ● Rated:                    ' + rated.length + '  green')
console.log('  ● Missing (load-bearing):   ' + loadBearingUnrated.length + '  red — CRITICAL')
console.log('  ● Missing (external):       ' + externalUnrated.length + '  orange — WARNING')
console.log('  ● Missing (other):          ' + otherUnrated.length + '  yellow')

// ── 7. Rating distribution ──────────────────────────────────────────────
if (Object.keys(ratingGroups).length > 0) {
  console.log('')
  console.log('── Fire Rating Distribution ──')
  const ratingsSorted = Object.entries(ratingGroups).sort((a, b) => b[1].length - a[1].length)
  for (const [rating, entities] of ratingsSorted) {
    console.log('  ' + rating + ': ' + entities.length + ' elements')
  }
}

// ── 8. Per-type breakdown ───────────────────────────────────────────────
console.log('')
console.log('── Breakdown by Element Type ──')
const typeGroups: Record<string, { rated: number; total: number }> = {}
for (const r of [...wallResults, ...doorResults, ...slabResults]) {
  const t = r.entity.Type
  if (!typeGroups[t]) typeGroups[t] = { rated: 0, total: 0 }
  typeGroups[t].total++
  if (r.rating) typeGroups[t].rated++
}
for (const [type, g] of Object.entries(typeGroups).sort((a, b) => b[1].total - a[1].total)) {
  const pct = (g.rated / g.total * 100).toFixed(0)
  console.log('  ' + type + ': ' + g.rated + '/' + g.total + ' rated (' + pct + '%)')
}

// ── 9. Critical issues list ─────────────────────────────────────────────
if (loadBearingUnrated.length > 0) {
  console.log('')
  console.warn('── CRITICAL: Load-Bearing Without Fire Rating ──')
  for (const e of loadBearingUnrated.slice(0, 15)) {
    console.warn('  ' + (e.Name || '<unnamed>') + ' [' + e.Type + '] GlobalId=' + e.GlobalId)
  }
  if (loadBearingUnrated.length > 15) console.warn('  ... and ' + (loadBearingUnrated.length - 15) + ' more')
}

// ── 10. Export all scanned elements with fire properties ────────────────
const allFireElements = [...walls, ...doors, ...slabs]
const fireCols = Array.from(firePropPaths).sort()
bim.export.csv(allFireElements, {
  columns: ['Name', 'Type', 'GlobalId', 'ObjectType', ...fireCols],
  filename: 'fire-safety-report.csv'
})
console.log('')
console.log('Exported ' + allFireElements.length + ' elements (' + (4 + fireCols.length) + ' columns) to fire-safety-report.csv')
`,r=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Quantity Takeoff ────────────────────────────────────────────────────
// Stakeholder: Cost Estimator / Project Manager
//
// Aggregates quantities (area, volume, length, width, height) across all
// structural and architectural element types. This combines what would
// require opening the properties panel for each element individually,
// manually recording numbers, and aggregating in a spreadsheet. The
// script does it in seconds and exports a ready-to-use CSV.
// ─────────────────────────────────────────────────────────────────────────

const ELEMENT_TYPES = [
  'IfcWall', 'IfcWallStandardCase',
  'IfcSlab',
  'IfcColumn',
  'IfcBeam',
  'IfcDoor', 'IfcDoorStandardCase',
  'IfcWindow',
  'IfcCovering',
  'IfcCurtainWall',
  'IfcRoof',
  'IfcStair', 'IfcStairFlight',
  'IfcRailing',
  'IfcPlate',
  'IfcMember',
  'IfcFooting',
  'IfcPile',
]

// Quantities we care about (case-insensitive matching)
const QTY_KEYS = ['area', 'volume', 'length', 'width', 'height', 'netarea', 'netsidearea', 'netvolume', 'grossarea', 'grossvolume', 'perimeter']

/**
 * One figure per element for the summary table, taken from the IFC standard
 * base-quantity names in priority order. Summing every quantity whose name
 * merely CONTAINS "volume" added GrossVolume, NetVolume and each exporter's
 * localised duplicates ("Brutto-Volumen der Wand", "Konditionales Volumen", …)
 * together, overstating a wall's volume ~3x; "area" likewise added a wall's
 * side area to its footprint area. Area priority runs side -> plan -> plain so
 * each class lands on the area that describes it: walls on GrossSideArea,
 * slabs and roofs on GrossArea, doors and windows on Area.
 */
const VOLUME_PRIORITY = ['GrossVolume', 'NetVolume']
const AREA_PRIORITY = ['GrossSideArea', 'NetSideArea', 'GrossArea', 'NetArea', 'Area']

/** Cap per type; beyond it the sums are extrapolated and labelled as such. */
const SAMPLE_CAP = 500

interface TypeTakeoff {
  type: string
  count: number
  sampled: number
  quantities: Record<string, { sum: number; count: number }>
  area: { sum: number; count: number }
  volume: { sum: number; count: number }
}

console.log('═══════════════════════════════════════')
console.log('  QUANTITY TAKEOFF')
console.log('═══════════════════════════════════════')
console.log('')

// One query, grouped by each element's CONCRETE class. \`byType\` already expands
// to subtypes, so querying \`IfcWall\` and \`IfcWallStandardCase\` separately
// returned the same walls twice and reported them as two types.
const elements = bim.query.byType(...ELEMENT_TYPES)
const byClass = new Map<string, BimEntity[]>()
for (const e of elements) {
  const list = byClass.get(e.Type)
  if (list) list.push(e)
  else byClass.set(e.Type, [e])
}

const takeoffs: TypeTakeoff[] = []
// Collect all unique Qto set+quantity paths for CSV export columns
const quantityColumns = new Set<string>()

for (const [type, entities] of byClass) {
  const sample = entities.length > SAMPLE_CAP ? entities.slice(0, SAMPLE_CAP) : entities
  const takeoff: TypeTakeoff = {
    type, count: entities.length, sampled: sample.length, quantities: {},
    area: { sum: 0, count: 0 }, volume: { sum: 0, count: 0 },
  }

  for (const entity of sample) {
    const byName = new Map<string, number>()
    for (const qset of bim.query.quantities(entity)) {
      for (const q of qset.quantities) {
        if (q.value === null || q.value === 0) continue
        const lower = q.name.toLowerCase()
        if (!QTY_KEYS.some(k => lower.includes(k))) continue
        if (!takeoff.quantities[q.name]) takeoff.quantities[q.name] = { sum: 0, count: 0 }
        takeoff.quantities[q.name].sum += q.value
        takeoff.quantities[q.name].count++
        if (!byName.has(q.name)) byName.set(q.name, q.value)
        quantityColumns.add(qset.name + '.' + q.name)
      }
    }
    const volume = VOLUME_PRIORITY.map(n => byName.get(n)).find(v => v !== undefined)
    if (volume !== undefined) { takeoff.volume.sum += volume; takeoff.volume.count++ }
    const area = AREA_PRIORITY.map(n => byName.get(n)).find(v => v !== undefined)
    if (area !== undefined) { takeoff.area.sum += area; takeoff.area.count++ }
  }

  // Scale up if sampled -- the report says so below rather than presenting an
  // extrapolation as a measured total.
  if (sample.length < entities.length) {
    const factor = entities.length / sample.length
    for (const q of Object.values(takeoff.quantities)) q.sum *= factor
    takeoff.area.sum *= factor
    takeoff.volume.sum *= factor
  }

  takeoffs.push(takeoff)
}

if (takeoffs.length === 0) {
  console.log('No ' + ELEMENT_TYPES.join(', ') + ' elements in this model, so there is nothing to take off.')
} else {
  // ── Report ────────────────────────────────────────────────────────────
  console.log('Scanned ' + elements.length + ' elements across ' + takeoffs.length + ' classes')
  console.log('')

  for (const t of takeoffs.sort((a, b) => b.count - a.count)) {
    const extrapolated = t.sampled < t.count ? '  [extrapolated from ' + t.sampled + ' of ' + t.count + ']' : ''
    console.log('── ' + t.type + ' (' + t.count + ')' + extrapolated + ' ──')
    const qEntries = Object.entries(t.quantities).sort((a, b) => b[1].sum - a[1].sum)
    if (qEntries.length === 0) {
      console.log('  (no quantities defined)')
    } else {
      for (const [name, q] of qEntries) {
        const avg = q.sum / q.count
        console.log('  ' + name + ': total=' + q.sum.toFixed(2) + '  avg=' + avg.toFixed(2) + '  (from ' + q.count + ' entities)')
      }
    }
    console.log('')
  }

  // ── Summary table ─────────────────────────────────────────────────────
  // Values are in the model's own length unit, squared and cubed. \`bim\` has no
  // project-unit accessor yet, so the column headers do not claim metres.
  console.log('── Summary (one standard base quantity per element) ──')
  console.log('Class                      | Count |    Area    |   Volume')
  console.log('---------------------------+-------+------------+-----------')
  for (const t of takeoffs) {
    const typeStr = (t.type + '                           ').slice(0, 27)
    const countStr = ('     ' + t.count).slice(-5)
    const areaStr = t.area.count > 0 ? t.area.sum.toFixed(1) : '-'
    const volStr = t.volume.count > 0 ? t.volume.sum.toFixed(2) : '-'
    const mark = t.sampled < t.count ? '  *' : ''
    console.log(typeStr + '| ' + countStr + ' | ' + ('          ' + areaStr).slice(-10) + ' | ' + ('         ' + volStr).slice(-9) + mark)
  }
  if (takeoffs.some(t => t.sampled < t.count)) {
    console.log('* extrapolated from the first ' + SAMPLE_CAP + ' elements of the class')
  }
}

// ── Export ───────────────────────────────────────────────────────────────
// Build a flat entity list with quantities for CSV export
let allElements = bim.query.byType(...ELEMENT_TYPES)
// Respect the active advanced filter, if one is set, so the CSV matches the
// current filtered view rather than the whole model (issue #1107).
const activeFilter = bim.query.matchingActiveFilter()
if (activeFilter) {
  const keep = new Set(activeFilter.map(e => e.ref.modelId + ':' + e.ref.expressId))
  const before = allElements.length
  allElements = allElements.filter(e => keep.has(e.ref.modelId + ':' + e.ref.expressId))
  console.log('Active filter applied: ' + allElements.length + ' of ' + before + ' elements')
}
if (allElements.length > 0) {
  const qtyCols = Array.from(quantityColumns).sort()
  bim.export.csv(allElements, {
    columns: ['Name', 'Type', 'ObjectType', 'GlobalId', ...qtyCols],
    filename: 'quantity-takeoff.csv'
  })
  console.log('')
  console.log('Exported ' + allElements.length + ' elements (' + (4 + qtyCols.length) + ' columns) to quantity-takeoff.csv')
}
`,i=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Building Envelope & Thermal Check ───────────────────────────────────
// Stakeholder: Architect / Energy Consultant
//
// Identifies all external-facing elements (walls, slabs, roofs, windows,
// doors, curtain walls) by reading Pset_*Common.IsExternal and checks
// whether they carry thermal transmittance values. Missing thermal data
// on external elements is a common issue in energy models. The script
// isolates the envelope, color-codes by thermal status, and exports
// the findings — a workflow that requires cross-referencing two property
// values across hundreds of elements.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()
bim.viewer.resetVisibility()

// ── 1. Gather envelope candidates ───────────────────────────────────────
const envelopeTypes = [
  'IfcWall', 'IfcWallStandardCase', 'IfcCurtainWall',
  'IfcSlab', 'IfcRoof',
  'IfcDoor', 'IfcDoorStandardCase',
  'IfcWindow',
  'IfcPlate',
]
const candidates = bim.query.byType(...envelopeTypes)

if (candidates.length === 0) {
  console.error('No envelope element types found')
  throw new Error('no elements')
}

// ── 2. Classify each element ────────────────────────────────────────────
interface EnvelopeResult {
  entity: BimEntity
  isExternal: boolean | null
  thermalTransmittance: number | null
  thermalSource: string
}

const results: EnvelopeResult[] = []
// Collect property paths for CSV export
const envelopePropPaths = new Set<string>()

for (const entity of candidates) {
  const result: EnvelopeResult = { entity, isExternal: null, thermalTransmittance: null, thermalSource: '' }
  const psets = bim.query.properties(entity)
  for (const pset of psets) {
    for (const p of pset.properties) {
      const lower = p.name.toLowerCase()
      if (lower === 'isexternal' && p.value !== null) {
        result.isExternal = p.value === true || p.value === 'TRUE' || p.value === '.T.'
        envelopePropPaths.add(pset.name + '.IsExternal')
      }
      if (lower === 'thermaltransmittance' && p.value !== null && p.value !== '') {
        result.thermalTransmittance = typeof p.value === 'number' ? p.value : parseFloat(String(p.value))
        result.thermalSource = pset.name
        envelopePropPaths.add(pset.name + '.ThermalTransmittance')
      }
      // Also capture other thermal-related properties
      if ((lower === 'firerating' || lower === 'loadbearing' || lower === 'acousticrating') && p.value !== null && p.value !== '') {
        envelopePropPaths.add(pset.name + '.' + p.name)
      }
    }
  }
  results.push(result)
}

// ── 3. Separate external vs internal ────────────────────────────────────
const external = results.filter(r => r.isExternal === true)
const internal = results.filter(r => r.isExternal === false)
const unknown = results.filter(r => r.isExternal === null)

const extWithThermal = external.filter(r => r.thermalTransmittance !== null)
const extNoThermal = external.filter(r => r.thermalTransmittance === null)

// ── 4. Color-code ───────────────────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (extWithThermal.length > 0) batches.push({ entities: extWithThermal.map(r => r.entity), color: '#27ae60' })  // green: external + thermal
if (extNoThermal.length > 0) batches.push({ entities: extNoThermal.map(r => r.entity), color: '#e74c3c' })    // red: external, missing thermal
if (internal.length > 0) batches.push({ entities: internal.map(r => r.entity), color: '#95a5a6' })            // grey: internal
if (unknown.length > 0) batches.push({ entities: unknown.map(r => r.entity), color: '#f39c12' })              // orange: unknown
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// Isolate envelope if we found external elements
if (external.length > 0) {
  bim.viewer.isolate(external.map(r => r.entity))
}

// ── 5. Report ───────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════')
console.log('  BUILDING ENVELOPE & THERMAL CHECK')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Scanned ' + candidates.length + ' envelope-type elements')
console.log('')
console.log('  External:   ' + external.length + '  (isolated in view)')
console.log('  Internal:   ' + internal.length + '  ● grey')
console.log('  Undefined:  ' + unknown.length + '  ● orange — IsExternal not set')
console.log('')
console.log('  External with thermal data:    ' + extWithThermal.length + '  ● green')
console.log('  External without thermal data: ' + extNoThermal.length + '  ● red — NEEDS ATTENTION')

// ── 6. Thermal value distribution ───────────────────────────────────────
if (extWithThermal.length > 0) {
  console.log('')
  console.log('── Thermal Transmittance (U-value) Distribution ──')

  // Group by type
  const byType: Record<string, number[]> = {}
  for (const r of extWithThermal) {
    if (!byType[r.entity.Type]) byType[r.entity.Type] = []
    if (r.thermalTransmittance !== null) byType[r.entity.Type].push(r.thermalTransmittance)
  }

  for (const [type, values] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    const min = Math.min(...values)
    const max = Math.max(...values)
    const avg = values.reduce((s, v) => s + v, 0) / values.length
    console.log('  ' + type + ' (' + values.length + ')')
    console.log('    min=' + min.toFixed(3) + '  avg=' + avg.toFixed(3) + '  max=' + max.toFixed(3) + ' W/(m²·K)')
  }
}

// ── 7. Elements missing IsExternal property ─────────────────────────────
if (unknown.length > 0) {
  console.log('')
  console.warn('── Missing IsExternal Property ──')
  const byType: Record<string, number> = {}
  for (const r of unknown) {
    byType[r.entity.Type] = (byType[r.entity.Type] || 0) + 1
  }
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.warn('  ' + type + ': ' + count + ' elements')
  }
}

// ── 8. External elements missing thermal data ───────────────────────────
if (extNoThermal.length > 0) {
  console.log('')
  console.warn('── External Elements Without Thermal Data ──')
  for (const r of extNoThermal.slice(0, 15)) {
    console.warn('  ' + (r.entity.Name || '<unnamed>') + ' [' + r.entity.Type + ']')
  }
  if (extNoThermal.length > 15) console.warn('  ... and ' + (extNoThermal.length - 15) + ' more')

  const envPropCols = Array.from(envelopePropPaths).sort()
  bim.export.csv(extNoThermal.map(r => r.entity), {
    columns: ['Name', 'Type', 'GlobalId', 'ObjectType', ...envPropCols],
    filename: 'envelope-missing-thermal.csv'
  })
  console.log('')
  console.log('Exported ' + extNoThermal.length + ' elements to envelope-missing-thermal.csv')
}

// Export full envelope dataset with all discovered properties
if (external.length > 0) {
  const envPropCols = Array.from(envelopePropPaths).sort()
  bim.export.csv(external.map(r => r.entity), {
    columns: ['Name', 'Type', 'GlobalId', 'ObjectType', ...envPropCols],
    filename: 'envelope-analysis.csv'
  })
  console.log('Exported ' + external.length + ' external elements (' + (4 + envPropCols.length) + ' columns) to envelope-analysis.csv')
}
`,a=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── MEP Equipment Schedule ──────────────────────────────────────────────
// Stakeholder: HVAC / MEP Engineer
//
// Discovers all MEP/distribution elements in the model, extracts their
// properties (manufacturer, model, capacity, pressure, flow rate), and
// generates a structured equipment register. The UI's property panel
// shows one element at a time — this script scans hundreds of elements
// and builds the schedule that would otherwise require a spreadsheet.
// ─────────────────────────────────────────────────────────────────────────

// ── 1. Query all MEP-related IFC types ──────────────────────────────────
const MEP_TYPES = [
  // HVAC
  'IfcAirTerminal', 'IfcAirTerminalBox', 'IfcFan', 'IfcCoil', 'IfcCompressor',
  'IfcCondenser', 'IfcCooledBeam', 'IfcCoolingTower', 'IfcEvaporativeCooler',
  'IfcEvaporator', 'IfcHeatExchanger', 'IfcHumidifier', 'IfcUnitaryEquipment',
  'IfcBoiler', 'IfcChiller', 'IfcAirToAirHeatRecovery',
  // Plumbing
  'IfcSanitaryTerminal', 'IfcWasteTerminal', 'IfcFireSuppressionTerminal',
  'IfcTank', 'IfcPump', 'IfcValve',
  // Electrical
  'IfcElectricDistributionBoard', 'IfcElectricGenerator', 'IfcElectricMotor',
  'IfcTransformer', 'IfcSwitchingDevice', 'IfcOutlet', 'IfcLightFixture',
  'IfcLamp', 'IfcJunctionBox',
  // Generic distribution
  'IfcDistributionElement', 'IfcDistributionControlElement',
  'IfcDistributionFlowElement', 'IfcFlowTerminal', 'IfcFlowMovingDevice',
  'IfcFlowController', 'IfcFlowStorageDevice', 'IfcFlowTreatmentDevice',
  'IfcFlowFitting', 'IfcFlowSegment', 'IfcEnergyConversionDevice',
  // Segments
  'IfcDuctSegment', 'IfcPipeSegment', 'IfcCableCarrierSegment', 'IfcCableSegment',
  'IfcDuctFitting', 'IfcPipeFitting', 'IfcCableCarrierFitting',
  // Furnishing (often used for MEP equipment in some models)
  'IfcFurnishingElement',
]

const elements = bim.query.byType(...MEP_TYPES)

if (elements.length === 0) {
  // Fall back: show what types ARE in the model so user can adapt
  console.warn('No standard MEP element types found.')
  console.log('')
  console.log('Available types in this model:')
  const all = bim.query.all()
  const types: Record<string, number> = {}
  for (const e of all) types[e.Type] = (types[e.Type] || 0) + 1
  for (const [t, c] of Object.entries(types).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + t + ': ' + c)
  }
  console.log('')
  console.log('Tip: edit MEP_TYPES at top of script to match your model\\'s types.')
  throw new Error('no MEP elements')
}

// ── 2. Group by IFC type ────────────────────────────────────────────────
const byType: Record<string, BimEntity[]> = {}
for (const e of elements) {
  if (!byType[e.Type]) byType[e.Type] = []
  byType[e.Type].push(e)
}

console.log('═══════════════════════════════════════')
console.log('  MEP EQUIPMENT SCHEDULE')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Found ' + elements.length + ' MEP elements across ' + Object.keys(byType).length + ' types')

// ── 3. Extract properties for each type ─────────────────────────────────
// Properties of interest for MEP equipment
const MEP_PROPS = [
  'manufacturer', 'model', 'reference', 'status',
  'capacity', 'power', 'voltage', 'current', 'frequency',
  'flowrate', 'pressure', 'temperature',
  'nominalcapacity', 'nominalpower',
]

interface EquipmentEntry {
  entity: BimEntity
  props: Record<string, string | number | boolean | null>
}

const schedule: Record<string, EquipmentEntry[]> = {}
// Collect all unique property paths for CSV export columns
const propertyColumns = new Set<string>()

for (const [type, entities] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  schedule[type] = []

  // Cap property extraction at 200 per type
  const sample = entities.length > 200 ? entities.slice(0, 200) : entities

  for (const entity of sample) {
    const entry: EquipmentEntry = { entity, props: {} }
    const psets = bim.query.properties(entity)
    for (const pset of psets) {
      for (const p of pset.properties) {
        const lower = p.name.toLowerCase()
        if (MEP_PROPS.some(k => lower.includes(k)) && p.value !== null && p.value !== '') {
          const path = pset.name + '.' + p.name
          entry.props[path] = p.value
          propertyColumns.add(path)
        }
      }
    }
    schedule[type].push(entry)
  }
}

// ── 4. Print schedule ───────────────────────────────────────────────────
for (const [type, entries] of Object.entries(schedule).sort((a, b) => b[1].length - a[1].length)) {
  console.log('')
  console.log('── ' + type + ' (' + byType[type].length + ') ──')

  // Collect all property keys found in this type
  const allKeys = new Set<string>()
  for (const entry of entries) {
    for (const key of Object.keys(entry.props)) allKeys.add(key)
  }

  if (allKeys.size === 0) {
    // Show name grouping even without properties
    const names: Record<string, number> = {}
    for (const entry of entries) {
      const key = entry.entity.Name || entry.entity.ObjectType || '<unnamed>'
      names[key] = (names[key] || 0) + 1
    }
    for (const [name, count] of Object.entries(names).sort((a, b) => b[1] - a[1])) {
      console.log('  ' + name + (count > 1 ? ' (x' + count + ')' : ''))
    }
  } else {
    // Show first 10 entries with their properties
    for (const entry of entries.slice(0, 10)) {
      const label = entry.entity.Name || entry.entity.ObjectType || '<unnamed>'
      console.log('  ' + label)
      for (const [key, value] of Object.entries(entry.props)) {
        console.log('    ' + key + ' = ' + value)
      }
    }
    if (entries.length > 10) console.log('  ... and ' + (entries.length - 10) + ' more')
  }
}

// ── 5. Color-code by system type ────────────────────────────────────────
const palette = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
  '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
]
const batches: Array<{ entities: BimEntity[]; color: string }> = []
let colorIdx = 0
for (const [type, entities] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  batches.push({ entities, color: palette[colorIdx % palette.length] })
  colorIdx++
}
bim.viewer.colorizeAll(batches)
bim.viewer.isolate(elements)

// ── 6. Summary ──────────────────────────────────────────────────────────
console.log('')
console.log('── Type Summary ──')
for (const [type, entities] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
  const color = palette[(Object.keys(byType).sort((a, b) => byType[b].length - byType[a].length).indexOf(type)) % palette.length]
  console.log('  ' + type + ': ' + entities.length + '  ● ' + color)
}

// ── 7. Export ────────────────────────────────────────────────────────────
const propCols = Array.from(propertyColumns).sort()
bim.export.csv(elements, {
  columns: ['Name', 'Type', 'ObjectType', 'GlobalId', 'Description', ...propCols],
  filename: 'mep-equipment-schedule.csv'
})
console.log('')
console.log('Exported ' + elements.length + ' MEP elements (' + (5 + propCols.length) + ' columns) to mep-equipment-schedule.csv')
console.log('Elements are isolated and color-coded by type in 3D view')
`,o=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Space & Room Validation ─────────────────────────────────────────────
// Stakeholder: Facility Manager / Architect
//
// Validates IfcSpace entities for operations handover readiness. Checks
// that every space has a Name, LongName, area and volume quantities,
// and required properties. Generates a room schedule with measurements
// and flags incomplete spaces. This would take hours of clicking through
// individual spaces in the property panel.
// ─────────────────────────────────────────────────────────────────────────

bim.viewer.resetColors()
bim.viewer.resetVisibility()

const spaces = bim.query.byType('IfcSpace')

if (spaces.length === 0) {
  console.warn('No IfcSpace entities found in this model.')
  console.log('')
  console.log('This script validates room/space data. Models without')
  console.log('IfcSpace entities are missing spatial programming data.')
  console.log('')
  // Show what spatial types exist
  const spatialTypes = bim.query.byType('IfcBuildingStorey', 'IfcBuilding', 'IfcSite')
  if (spatialTypes.length > 0) {
    console.log('Spatial structure found:')
    for (const e of spatialTypes) {
      console.log('  ' + e.Type + ': ' + (e.Name || '<unnamed>'))
    }
  }
  throw new Error('no spaces')
}

// ── 1. Extract space data ───────────────────────────────────────────────
interface SpaceData {
  entity: BimEntity
  area: number | null
  volume: number | null
  perimeter: number | null
  height: number | null
  longName: string | null
  category: string | null
  occupancy: string | null
  issues: string[]
}

const spaceData: SpaceData[] = []
// Collect property/quantity paths for CSV export
const spacePropPaths = new Set<string>()
const spaceQtyPaths = new Set<string>()

for (const space of spaces) {
  const data: SpaceData = {
    entity: space, area: null, volume: null, perimeter: null, height: null,
    longName: null, category: null, occupancy: null, issues: []
  }

  // Extract quantities by their standard Qto_SpaceBaseQuantities names, in
  // priority order. Matching any name that CONTAINS "volume" would take an
  // exporter's localised duplicate (e.g. ArchiCADQuantities) if it came first.
  const qsets = bim.query.quantities(space)
  const byName = new Map<string, number>()
  for (const qset of qsets) {
    for (const q of qset.quantities) {
      if (typeof q.value === 'number' && !byName.has(q.name)) byName.set(q.name, q.value)
      if (q.value !== null && q.value !== 0) spaceQtyPaths.add(qset.name + '.' + q.name)
    }
  }
  const pick = (names: string[]) => names.map(n => byName.get(n)).find(v => v !== undefined) ?? null
  data.area = pick(['NetFloorArea', 'GrossFloorArea'])
  data.volume = pick(['NetVolume', 'GrossVolume'])
  data.perimeter = pick(['GrossPerimeter', 'NetPerimeter'])
  data.height = pick(['Height', 'FinishCeilingHeight'])

  // Extract properties
  const psets = bim.query.properties(space)
  for (const pset of psets) {
    for (const p of pset.properties) {
      const lower = p.name.toLowerCase()
      if (lower === 'longname' && p.value) data.longName = String(p.value)
      if (lower === 'category' && p.value) data.category = String(p.value)
      if (lower === 'occupancytype' && p.value) data.occupancy = String(p.value)
      if (p.value !== null && p.value !== '') spacePropPaths.add(pset.name + '.' + p.name)
    }
  }

  // \`LongName\` is an EXPRESS attribute of IfcSpace (the room's human name --
  // "Schlafzimmer", where \`Name\` is the room number "4"), not a property-set
  // value, so the pset scan above can never find it. Reading only psets flagged
  // every room of every model "Missing LongName" and named the schedule rows by
  // number.
  if (!data.longName) {
    const longName = bim.query.attributes(space).find(a => a.name === 'LongName')?.value
    if (longName !== null && longName !== undefined && longName !== '') data.longName = String(longName)
  }
  if (!data.longName && space.Description) data.longName = space.Description

  // Check for issues
  if (!space.Name || space.Name === '') data.issues.push('Missing Name')
  if (!data.longName) data.issues.push('Missing LongName/Description')
  if (data.area === null) data.issues.push('Missing Area')
  if (data.volume === null) data.issues.push('Missing Volume')

  spaceData.push(data)
}

// ── 2. Classify spaces ─────────────────────────────────────────────────
const complete = spaceData.filter(s => s.issues.length === 0)
const incomplete = spaceData.filter(s => s.issues.length > 0)

// ── 3. Color-code ───────────────────────────────────────────────────────
const batches: Array<{ entities: BimEntity[]; color: string }> = []
if (complete.length > 0) batches.push({ entities: complete.map(s => s.entity), color: '#27ae60' })
const minor = incomplete.filter(s => s.issues.length <= 2)
const major = incomplete.filter(s => s.issues.length > 2)
if (minor.length > 0) batches.push({ entities: minor.map(s => s.entity), color: '#f39c12' })
if (major.length > 0) batches.push({ entities: major.map(s => s.entity), color: '#e74c3c' })
if (batches.length > 0) bim.viewer.colorizeAll(batches)

// ── 4. Report ───────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════')
console.log('  SPACE & ROOM VALIDATION')
console.log('═══════════════════════════════════════')
console.log('')
console.log('Spaces found: ' + spaces.length)
console.log('  Complete:     ' + complete.length + '  ● green')
console.log('  Minor issues: ' + minor.length + '  ● orange (1-2 issues)')
console.log('  Major issues: ' + major.length + '  ● red (3+ issues)')

// ── 5. Room schedule ────────────────────────────────────────────────────
console.log('')
console.log('── Room Schedule ──')
console.log('Name                    | Area m²  | Volume m³ | Height m | Status')
console.log('------------------------+----------+-----------+----------+-------')

// Sort by name
const sorted = [...spaceData].sort((a, b) => {
  const nameA = a.entity.Name || 'zzz'
  const nameB = b.entity.Name || 'zzz'
  return nameA.localeCompare(nameB)
})

let totalArea = 0
let totalVolume = 0

for (const s of sorted) {
  const label = s.longName ? (s.entity.Name ? s.entity.Name + ' ' + s.longName : s.longName) : (s.entity.Name || '<unnamed>')
  const name = (label + '                        ').slice(0, 24)
  const area = s.area !== null ? (s.area.toFixed(1) + '    ').slice(0, 8) : '-       '
  const vol = s.volume !== null ? (s.volume.toFixed(1) + '     ').slice(0, 9) : '-        '
  const height = s.height !== null ? (s.height.toFixed(2) + '   ').slice(0, 8) : '-       '
  const status = s.issues.length === 0 ? 'OK' : s.issues.length + ' issues'
  console.log(name + '| ' + area + ' | ' + vol + ' | ' + height + ' | ' + status)
  if (s.area !== null) totalArea += s.area
  if (s.volume !== null) totalVolume += s.volume
}

console.log('------------------------+----------+-----------+----------+-------')
console.log('TOTALS                  | ' + (totalArea.toFixed(1) + '    ').slice(0, 8) + ' | ' + (totalVolume.toFixed(1) + '     ').slice(0, 9) + ' |')

// ── 6. Category breakdown ───────────────────────────────────────────────
const categories: Record<string, { count: number; area: number }> = {}
for (const s of spaceData) {
  const cat = s.category || s.entity.ObjectType || 'Uncategorized'
  if (!categories[cat]) categories[cat] = { count: 0, area: 0 }
  categories[cat].count++
  if (s.area !== null) categories[cat].area += s.area
}

if (Object.keys(categories).length > 1) {
  console.log('')
  console.log('── By Category ──')
  for (const [cat, data] of Object.entries(categories).sort((a, b) => b[1].area - a[1].area)) {
    console.log('  ' + cat + ': ' + data.count + ' spaces, ' + data.area.toFixed(1) + ' m²')
  }
}

// ── 7. Issue details ────────────────────────────────────────────────────
if (incomplete.length > 0) {
  console.log('')
  console.warn('── Incomplete Spaces ──')
  const issueCount: Record<string, number> = {}
  for (const s of incomplete) {
    for (const issue of s.issues) {
      issueCount[issue] = (issueCount[issue] || 0) + 1
    }
  }
  for (const [issue, count] of Object.entries(issueCount).sort((a, b) => b[1] - a[1])) {
    console.warn('  ' + issue + ': ' + count + ' spaces')
  }
}

// ── 8. Export ────────────────────────────────────────────────────────────
const spPropCols = Array.from(spacePropPaths).sort().slice(0, 15)
const spQtyCols = Array.from(spaceQtyPaths).sort().slice(0, 15)
bim.export.csv(spaces, {
  columns: ['Name', 'Type', 'GlobalId', 'Description', 'ObjectType', ...spPropCols, ...spQtyCols],
  filename: 'room-schedule.csv'
})
console.log('')
console.log('Exported ' + spaces.length + ' spaces (' + (5 + spPropCols.length + spQtyCols.length) + ' columns) to room-schedule.csv')
`,s=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Multi-Model Federation Comparison ───────────────────────────────────
// Stakeholder: Project Manager / BIM Coordinator
//
// When multiple IFC models are loaded (architectural + structural + MEP),
// this script compares them side by side: entity counts, type coverage,
// naming consistency, and property completeness per model. The UI shows
// one tree at a time — this script cross-references everything and
// highlights discrepancies that indicate coordination issues.
// ─────────────────────────────────────────────────────────────────────────

const models = bim.model.list()

if (models.length === 0) {
  console.error('No models loaded')
  throw new Error('no models')
}

console.log('═══════════════════════════════════════')
console.log('  FEDERATION COMPARISON')
console.log('═══════════════════════════════════════')
console.log('')

// ── 1. Model overview ───────────────────────────────────────────────────
console.log('── Loaded Models (' + models.length + ') ──')
let totalEntities = 0
for (const m of models) {
  const sizeMB = (m.fileSize / 1024 / 1024).toFixed(1)
  console.log('  [' + m.id.slice(0, 8) + '] ' + m.name)
  console.log('    Schema: ' + m.schemaVersion + '  |  Entities: ' + m.entityCount + '  |  Size: ' + sizeMB + ' MB')
  totalEntities += m.entityCount
}
console.log('')
console.log('Total: ' + totalEntities + ' entities across ' + models.length + ' models')

// ── 2. Type distribution per model ──────────────────────────────────────
const all = bim.query.all()

// Build type→model distribution
const typeByModel: Record<string, Record<string, number>> = {}
const modelEntityMap: Record<string, BimEntity[]> = {}
for (const e of all) {
  const mid = e.ref.modelId
  if (!modelEntityMap[mid]) modelEntityMap[mid] = []
  modelEntityMap[mid].push(e)

  if (!typeByModel[e.Type]) typeByModel[e.Type] = {}
  typeByModel[e.Type][mid] = (typeByModel[e.Type][mid] || 0) + 1
}

// Find types that exist in multiple models (potential overlaps/conflicts)
const sharedTypes: string[] = []
const exclusiveTypes: Record<string, string[]> = {} // modelId → types only in that model

for (const [type, distribution] of Object.entries(typeByModel)) {
  const modelIds = Object.keys(distribution)
  if (modelIds.length > 1) {
    sharedTypes.push(type)
  } else {
    const mid = modelIds[0]
    if (!exclusiveTypes[mid]) exclusiveTypes[mid] = []
    exclusiveTypes[mid].push(type)
  }
}

console.log('')
console.log('── Type Distribution ──')
console.log('')

// Types present in multiple models
if (sharedTypes.length > 0) {
  console.log('Types shared across models (' + sharedTypes.length + '):')
  const header = '  Type                         ' + models.map(m => ('| ' + m.name.slice(0, 10) + '          ').slice(0, 13)).join('')
  console.log(header)
  console.log('  ' + '-'.repeat(header.length - 2))

  for (const type of sharedTypes.sort((a, b) => {
    const totalA = Object.values(typeByModel[a]).reduce((s, v) => s + v, 0)
    const totalB = Object.values(typeByModel[b]).reduce((s, v) => s + v, 0)
    return totalB - totalA
  }).slice(0, 20)) {
    const typeStr = (type + '                              ').slice(0, 30)
    const counts = models.map(m => {
      const c = typeByModel[type][m.id] || 0
      return ('| ' + (c > 0 ? String(c) : '-') + '           ').slice(0, 13)
    }).join('')
    console.log('  ' + typeStr + counts)
  }
}

// Types exclusive to one model
console.log('')
console.log('Types exclusive to one model:')
for (const m of models) {
  const exclusive = exclusiveTypes[m.id] || []
  if (exclusive.length > 0) {
    console.log('  ' + m.name + ': ' + exclusive.slice(0, 8).join(', ') + (exclusive.length > 8 ? ' (+' + (exclusive.length - 8) + ' more)' : ''))
  }
}

// ── 3. Naming consistency check ─────────────────────────────────────────
console.log('')
console.log('── Naming Consistency ──')
for (const m of models) {
  const entities = modelEntityMap[m.id] || []
  const named = entities.filter(e => e.Name && e.Name !== '')
  const described = entities.filter(e => e.Description && e.Description !== '')
  const typed = entities.filter(e => e.ObjectType && e.ObjectType !== '')
  const namePct = entities.length > 0 ? (named.length / entities.length * 100).toFixed(1) : '0'
  const descPct = entities.length > 0 ? (described.length / entities.length * 100).toFixed(1) : '0'
  const typePct = entities.length > 0 ? (typed.length / entities.length * 100).toFixed(1) : '0'
  console.log('  ' + m.name + ':')
  console.log('    Named: ' + namePct + '%  |  Described: ' + descPct + '%  |  ObjectType: ' + typePct + '%')
}

// ── 4. Property coverage comparison ─────────────────────────────────────
console.log('')
console.log('── Property Coverage (sample of 100 per model) ──')
for (const m of models) {
  const entities = modelEntityMap[m.id] || []
  const sample = entities.slice(0, 100)
  let withPsets = 0
  let withQsets = 0
  let totalPsets = 0
  for (const e of sample) {
    const psets = bim.query.properties(e)
    const qsets = bim.query.quantities(e)
    if (psets.length > 0) withPsets++
    if (qsets.length > 0) withQsets++
    totalPsets += psets.length
  }
  const psetPct = sample.length > 0 ? (withPsets / sample.length * 100).toFixed(0) : '0'
  const qsetPct = sample.length > 0 ? (withQsets / sample.length * 100).toFixed(0) : '0'
  const avgPsets = sample.length > 0 ? (totalPsets / sample.length).toFixed(1) : '0'
  console.log('  ' + m.name + ':')
  console.log('    With properties: ' + psetPct + '%  |  With quantities: ' + qsetPct + '%  |  Avg psets/entity: ' + avgPsets)
}

// ── 5. Potential coordination issues ────────────────────────────────────
if (models.length > 1) {
  console.log('')
  console.log('── Coordination Notes ──')

  // Check for spatial types in non-architectural models
  const spatialTypes = ['IfcBuilding', 'IfcBuildingStorey', 'IfcSite', 'IfcSpace']
  for (const m of models) {
    const hasSpatial: string[] = []
    for (const st of spatialTypes) {
      if (typeByModel[st] && typeByModel[st][m.id]) {
        hasSpatial.push(st + '(' + typeByModel[st][m.id] + ')')
      }
    }
    if (hasSpatial.length > 0) {
      console.log('  ' + m.name + ' defines: ' + hasSpatial.join(', '))
    }
  }

  // Check entity count ratios (large disparities may indicate issues)
  const counts = models.map(m => modelEntityMap[m.id]?.length || 0)
  const maxCount = Math.max(...counts)
  const minCount = Math.min(...counts)
  if (maxCount > 0 && minCount > 0 && maxCount / minCount > 10) {
    console.warn('')
    console.warn('  Large entity count disparity (' + maxCount + ' vs ' + minCount + ')')
    console.warn('  This may indicate models at different levels of detail')
  }
}

// ── 6. Color-code by model origin ───────────────────────────────────────
const modelColors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']
const colorBatches: Array<{ entities: BimEntity[]; color: string }> = []
let idx = 0
for (const m of models) {
  const entities = modelEntityMap[m.id] || []
  if (entities.length > 0) {
    colorBatches.push({ entities, color: modelColors[idx % modelColors.length] })
    idx++
  }
}
if (colorBatches.length > 0) bim.viewer.colorizeAll(colorBatches)

console.log('')
console.log('── Model Colors ──')
idx = 0
for (const m of models) {
  console.log('  ' + m.name + '  ● ' + modelColors[idx % modelColors.length])
  idx++
}
`,c=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// Reset colors and visibility
bim.viewer.resetColors()
bim.viewer.resetVisibility()
console.log('View reset — all colors and visibility restored')
`,l=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary for type checking
/**
 * Create IFC from scratch: two storeys with attributed structure, filled
 * openings, a straight stair, and a parametric timber gridshell.
 * Positions passed to element constructors are relative to their storey.
 */

type Point3 = [number, number, number];
const footprintWidth = 5;
const footprintDepth = 8;
const storeyHeight = 3;
const wallThickness = 0.2;
const slabThickness = 0.3;
const concreteDensity = 2400;
const steelDensity = 7850;

const h = bim.create.project({
  Name: 'Sample Building',
  Description: 'Demonstration of ifc-lite IFC creation from scratch',
  Author: 'ifc-lite',
  Organization: 'ifc-lite',
});
const ground = bim.create.addIfcBuildingStorey(h, { Name: 'Ground Floor', Elevation: 0 });
const first = bim.create.addIfcBuildingStorey(h, { Name: 'First Floor', Elevation: storeyHeight });

function finish(
  id: number, colorName: string, rgb: [number, number, number],
  material: { Name: string; Category?: string; Layers?: { Name: string; Thickness: number; Category: string }[] },
): void {
  bim.create.setColor(h, id, colorName, rgb);
  bim.create.addIfcMaterial(h, id, material);
}

// The layers total the modeled 200 mm wall thickness.
const wallMaterial = {
  Name: 'Exterior Wall Assembly',
  Layers: [
    { Name: 'Gypsum Board', Thickness: 0.01, Category: 'Finish' },
    { Name: 'Mineral Wool Insulation', Thickness: 0.08, Category: 'Insulation' },
    { Name: 'Concrete C30/37', Thickness: 0.1, Category: 'Structural' },
    { Name: 'External Render', Thickness: 0.01, Category: 'Finish' },
  ],
};
const slabMaterial = {
  Name: 'Floor Slab Assembly',
  Layers: [
    { Name: 'Ceramic Tile', Thickness: 0.01, Category: 'Finish' },
    { Name: 'Screed', Thickness: 0.05, Category: 'Finish' },
    { Name: 'Reinforced Concrete C30/37', Thickness: 0.24, Category: 'Structural' },
  ],
};
const columnMaterial = { Name: 'Reinforced Concrete C30/37', Category: 'Concrete' };
const beamMaterial = { Name: 'Structural Steel S235', Category: 'Steel' };

type Opening = { Name: string; Width: number; Height: number; Position: Point3; Kind: 'door' | 'window' };
type WallSide = { Name: string; Start: Point3; End: Point3; Openings?: Opening[] };

function addWalls(storey: number, floor: number): void {
  // Opening positions are wall local: distance along Start→End, 0, sill height.
  const sides: WallSide[] = [
    { Name: 'South Wall', Start: [0, 0, 0], End: [footprintWidth, 0, 0],
      Openings: [{ Name: floor === 0 ? 'W-01 Window' : 'W-03 Window',
        Width: 1.2, Height: 1.5, Position: [1.5, 0, 0.9], Kind: 'window' }] },
    { Name: 'East Wall', Start: [footprintWidth, 0, 0], End: [footprintWidth, footprintDepth, 0],
      Openings: floor === 0
        ? [{ Name: 'D-01 Entrance Door', Width: 0.9, Height: 2.1, Position: [3, 0, 0], Kind: 'door' }]
        : [{ Name: 'W-04 Window', Width: 1.4, Height: 1.5, Position: [3, 0, 0.9], Kind: 'window' }] },
    { Name: 'North Wall', Start: [footprintWidth, footprintDepth, 0], End: [0, footprintDepth, 0],
      Openings: [{ Name: floor === 0 ? 'W-02 Window' : 'W-05 Window',
        Width: 1.4, Height: 1.5, Position: [1.8, 0, 0.9], Kind: 'window' }] },
    { Name: 'West Wall', Start: [0, footprintDepth, 0], End: [0, 0, 0] },
  ];

  for (const side of sides) {
    const length = Math.hypot(side.End[0] - side.Start[0], side.End[1] - side.Start[1]);
    const id = bim.create.addIfcWall(h, storey, {
      Name: side.Name, Description: 'Exterior wall', ObjectType: 'Basic Wall:Exterior - 200mm',
      Start: side.Start, End: side.End, Thickness: wallThickness, Height: storeyHeight,
    });
    finish(id, 'Plaster - Beige', [0.92, 0.88, 0.80], wallMaterial);
    bim.create.addIfcPropertySet(h, id, {
      Name: 'Pset_WallCommon',
      Properties: [
        { Name: 'Reference', NominalValue: 'Exterior - 200mm', Type: 'IfcIdentifier' },
        { Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'FireRating', NominalValue: 'REI60', Type: 'IfcLabel' },
        { Name: 'AcousticRating', NominalValue: 'STC 45', Type: 'IfcLabel' },
        // The current create API supports IfcReal, not the dedicated IFC measure type.
        { Name: 'ThermalTransmittance', NominalValue: 0.25, Type: 'IfcReal' },
      ],
    });
    bim.create.addIfcElementQuantity(h, id, {
      Name: 'Qto_WallBaseQuantities',
      Quantities: [
        { Name: 'Length', Value: length, Kind: 'IfcQuantityLength' },
        { Name: 'Height', Value: storeyHeight, Kind: 'IfcQuantityLength' },
        { Name: 'Width', Value: wallThickness, Kind: 'IfcQuantityLength' },
        { Name: 'GrossSideArea', Value: length * storeyHeight, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: length * storeyHeight * wallThickness, Kind: 'IfcQuantityVolume' },
      ],
    });
    for (const opening of side.Openings ?? []) {
      const { Kind, ...params } = opening;
      const fillId = Kind === 'door'
        ? bim.create.addIfcWallDoor(h, id, params)
        : bim.create.addIfcWallWindow(h, id, params);
      finish(fillId, Kind === 'door' ? 'Timber - Door' : 'Glass - Blue',
        Kind === 'door' ? [0.55, 0.38, 0.23] : [0.48, 0.72, 0.85],
        Kind === 'door' ? { Name: 'Timber Door', Category: 'Timber' }
          : { Name: 'Glazing', Category: 'Glass' });
      bim.create.addIfcPropertySet(h, fillId, {
        Name: Kind === 'door' ? 'Pset_DoorCommon' : 'Pset_WindowCommon',
        Properties: [{ Name: 'IsExternal', NominalValue: true, Type: 'IfcBoolean' }],
      });
      bim.create.addIfcElementQuantity(h, fillId, {
        Name: Kind === 'door' ? 'Qto_DoorBaseQuantities' : 'Qto_WindowBaseQuantities',
        Quantities: [
          { Name: 'Width', Value: opening.Width, Kind: 'IfcQuantityLength' },
          { Name: 'Height', Value: opening.Height, Kind: 'IfcQuantityLength' },
          { Name: 'Area', Value: opening.Width * opening.Height, Kind: 'IfcQuantityArea' },
        ],
      });
    }
  }
}

const numRisers = 17;
const riserHeight = 0.176;
const treadLength = 0.28;
const stairWidth = 1;
const stairStartY = 1;
const stairRun = numRisers * treadLength;
const stairOpeningLength = 4.2;
const stairOpeningWidth = stairWidth + 0.2;
// The opening spans x=0..1.2 and y=1.56..5.76, within the slab.
const stairOpeningCenter: Point3 = [
  stairOpeningWidth / 2, stairStartY + stairRun - stairOpeningLength / 2, 0,
];

function addSlab(storey: number, name: string, hasStairOpening: boolean): void {
  const openingArea = hasStairOpening ? stairOpeningWidth * stairOpeningLength : 0;
  const grossArea = footprintWidth * footprintDepth;
  const id = bim.create.addIfcSlab(h, storey, {
    Name: name, Description: 'Reinforced concrete floor slab', ObjectType: 'Floor:Concrete - 300mm',
    Position: [0, 0, -slabThickness], Thickness: slabThickness,
    Width: footprintWidth, Depth: footprintDepth,
    Openings: hasStairOpening ? [{
      Name: 'Stair Opening', Width: stairOpeningWidth, Height: stairOpeningLength,
      Position: stairOpeningCenter,
    }] : undefined,
  });
  finish(id, 'Concrete - Grey', [0.65, 0.65, 0.65], slabMaterial);
  bim.create.addIfcPropertySet(h, id, {
    Name: 'Pset_SlabCommon',
    Properties: [
      { Name: 'Reference', NominalValue: 'Concrete - 300mm', Type: 'IfcIdentifier' },
      { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
      { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
      { Name: 'FireRating', NominalValue: 'REI90', Type: 'IfcLabel' },
      { Name: 'AcousticRating', NominalValue: 'STC 52', Type: 'IfcLabel' },
      { Name: 'Combustible', NominalValue: false, Type: 'IfcBoolean' },
    ],
  });
  bim.create.addIfcElementQuantity(h, id, {
    Name: 'Qto_SlabBaseQuantities',
    Quantities: [
      { Name: 'Width', Value: slabThickness, Kind: 'IfcQuantityLength' },
      { Name: 'GrossArea', Value: grossArea, Kind: 'IfcQuantityArea' },
      { Name: 'NetArea', Value: grossArea - openingArea, Kind: 'IfcQuantityArea' },
      { Name: 'GrossVolume', Value: grossArea * slabThickness, Kind: 'IfcQuantityVolume' },
      { Name: 'NetVolume', Value: (grossArea - openingArea) * slabThickness, Kind: 'IfcQuantityVolume' },
      { Name: 'GrossWeight', Value: grossArea * slabThickness * concreteDensity, Kind: 'IfcQuantityWeight' },
    ],
  });
}

const columnPositions: [string, number, number][] = [
  ['C-01 SW', 0.1, 0.1], ['C-02 SE', 4.7, 0.1],
  ['C-03 NE', 4.7, 7.7], ['C-04 NW', 0.1, 7.7],
];
function addColumns(storey: number): void {
  const sectionArea = 0.3 * 0.3;
  for (const [name, x, y] of columnPositions) {
    const id = bim.create.addIfcColumn(h, storey, {
      Name: name, Description: 'Reinforced concrete column', ObjectType: 'Column:Concrete 300x300',
      Position: [x, y, 0], Width: 0.3, Depth: 0.3, Height: storeyHeight,
    });
    finish(id, 'Concrete - Light', [0.72, 0.72, 0.74], columnMaterial);
    bim.create.addIfcPropertySet(h, id, {
      Name: 'Pset_ColumnCommon',
      Properties: [
        { Name: 'Reference', NominalValue: 'Concrete 300x300', Type: 'IfcIdentifier' },
        { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
        { Name: 'FireRating', NominalValue: 'R120', Type: 'IfcLabel' },
        { Name: 'Slope', NominalValue: 0, Type: 'IfcReal' },
      ],
    });
    bim.create.addIfcElementQuantity(h, id, {
      Name: 'Qto_ColumnBaseQuantities',
      Quantities: [
        { Name: 'Length', Value: storeyHeight, Kind: 'IfcQuantityLength' },
        { Name: 'CrossSectionArea', Value: sectionArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: sectionArea * storeyHeight, Kind: 'IfcQuantityVolume' },
        { Name: 'GrossWeight', Value: sectionArea * storeyHeight * concreteDensity, Kind: 'IfcQuantityWeight' },
      ],
    });
  }
}

function addStructuralBeams(storey: number): void {
  // The creator emits rectangular sections, so describe and quantify them as such.
  const sectionArea = 0.2 * 0.4;
  for (const [name, y] of [['B-01 South Beam', 0], ['B-02 North Beam', footprintDepth]] as [string, number][]) {
    const id = bim.create.addIfcBeam(h, storey, {
      Name: name, Description: 'Rectangular steel beam', ObjectType: 'Beam:Steel 200x400',
      Start: [0, y, storeyHeight], End: [footprintWidth, y, storeyHeight],
      Width: 0.2, Height: 0.4,
    });
    finish(id, 'Steel - Grey', [0.55, 0.55, 0.58], beamMaterial);
    bim.create.addIfcPropertySet(h, id, {
      Name: 'Pset_BeamCommon',
      Properties: [
        { Name: 'Reference', NominalValue: 'Steel 200x400', Type: 'IfcIdentifier' },
        { Name: 'LoadBearing', NominalValue: true, Type: 'IfcBoolean' },
        { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
        { Name: 'FireRating', NominalValue: 'R60', Type: 'IfcLabel' },
        { Name: 'Span', NominalValue: footprintWidth, Type: 'IfcReal' },
      ],
    });
    bim.create.addIfcElementQuantity(h, id, {
      Name: 'Qto_BeamBaseQuantities',
      Quantities: [
        { Name: 'Length', Value: footprintWidth, Kind: 'IfcQuantityLength' },
        { Name: 'CrossSectionArea', Value: sectionArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: footprintWidth * sectionArea, Kind: 'IfcQuantityVolume' },
        { Name: 'GrossWeight', Value: footprintWidth * sectionArea * steelDensity, Kind: 'IfcQuantityWeight' },
      ],
    });
  }
}

addWalls(ground, 0);
addSlab(ground, 'Ground Floor Slab', false);
addColumns(ground);
addStructuralBeams(ground);

// Direction rotates the stair run toward +Y and its width toward -X.
const stair = bim.create.addIfcStair(h, ground, {
  Name: 'ST-01 Main Stair', Description: 'Straight-run concrete stair',
  ObjectType: 'Stair:Concrete - Straight Run',
  Position: [stairWidth, stairStartY, 0], Direction: Math.PI / 2,
  NumberOfRisers: numRisers, RiserHeight: riserHeight,
  TreadLength: treadLength, Width: stairWidth,
});
finish(stair, 'Concrete - Warm', [0.80, 0.78, 0.74],
  { Name: 'Reinforced Concrete C25/30', Category: 'Concrete' });
bim.create.addIfcPropertySet(h, stair, {
  Name: 'Pset_StairCommon',
  Properties: [
    { Name: 'Reference', NominalValue: 'Concrete - Straight Run', Type: 'IfcIdentifier' },
    { Name: 'FireRating', NominalValue: 'REI60', Type: 'IfcLabel' },
    { Name: 'NumberOfRiser', NominalValue: numRisers, Type: 'IfcInteger' },
    { Name: 'NumberOfTreads', NominalValue: numRisers, Type: 'IfcInteger' },
    { Name: 'RiserHeight', NominalValue: riserHeight, Type: 'IfcReal' },
    { Name: 'TreadLength', NominalValue: treadLength, Type: 'IfcReal' },
    { Name: 'IsExternal', NominalValue: false, Type: 'IfcBoolean' },
    { Name: 'HandicapAccessible', NominalValue: false, Type: 'IfcBoolean' },
  ],
});
// The creator emits one rectangular tread solid for each riser.
bim.create.addIfcElementQuantity(h, stair, {
  Name: 'Example_StairQuantities', // Qto_StairFlightBaseQuantities targets IfcStairFlight.
  Quantities: [
    { Name: 'Length', Value: stairRun, Kind: 'IfcQuantityLength' },
    { Name: 'GrossVolume', Value: stairRun * stairWidth * riserHeight, Kind: 'IfcQuantityVolume' },
  ],
});

addSlab(first, 'First Floor Slab', true);
addWalls(first, 1);
addColumns(first);
addStructuralBeams(first);

// Two diagonal families form a diamond lattice on a doubly curved surface.
const crown = 1.8;
const divisionsX = 10;
const divisionsY = 16;
const lathWidth = 0.06;
const lathDepth = 0.08;
// Replace roofZ to explore a symmetric dome:
// return storeyHeight + crown * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
// Or rolling dunes: multiply that envelope by several Gaussian peaks.
function roofZ(u: number, v: number): number {
  const envelope = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
  const twist = (2 * u - 1) * (2 * v - 1);
  return storeyHeight + crown * envelope * (1 + 0.8 * twist);
}
const grid: Point3[][] = [];
for (let i = 0; i <= divisionsX; i++) {
  const row: Point3[] = [];
  for (let j = 0; j <= divisionsY; j++) {
    const u = i / divisionsX;
    const v = j / divisionsY;
    row.push([u * footprintWidth, v * footprintDepth, roofZ(u, v)]);
  }
  grid.push(row);
}
function timberBeam(name: string, start: Point3, end: Point3, ring: boolean): void {
  const id = bim.create.addIfcBeam(h, first, {
    Name: name, Description: ring ? 'Gridshell perimeter ring beam' : 'Gridshell lath',
    ObjectType: ring ? 'Beam:GL28h 120x200' : 'Timber Lath:GL24h 60x80',
    Start: start, End: end, Width: ring ? 0.12 : lathWidth, Height: ring ? 0.20 : lathDepth,
  });
  finish(id, ring ? 'Timber - Dark' : name.startsWith('GL-A') ? 'Timber - Larch' : 'Timber - Oak',
    ring ? [0.45, 0.32, 0.20] : name.startsWith('GL-A') ? [0.82, 0.62, 0.38] : [0.72, 0.52, 0.30],
    { Name: ring ? 'Glulam GL28h Larch' : 'Glulam GL24h Spruce', Category: 'Timber' });
}
let lathCount = 0;
for (let i = 0; i < divisionsX; i++) {
  for (let j = 0; j < divisionsY; j++) {
    timberBeam(\`GL-A/\${i}/\${j}\`, grid[i][j], grid[i + 1][j + 1], false);
    timberBeam(\`GL-B/\${i}/\${j}\`, grid[i][j + 1], grid[i + 1][j], false);
    lathCount += 2;
  }
}
const ringPoints: Point3[] = [];
for (let i = 0; i <= divisionsX; i++) ringPoints.push(grid[i][0]);
for (let j = 1; j <= divisionsY; j++) ringPoints.push(grid[divisionsX][j]);
for (let i = divisionsX - 1; i >= 0; i--) ringPoints.push(grid[i][divisionsY]);
for (let j = divisionsY - 1; j >= 1; j--) ringPoints.push(grid[0][j]);
for (let k = 0; k < ringPoints.length; k++) {
  timberBeam(\`GL-Ring/\${k}\`, ringPoints[k], ringPoints[(k + 1) % ringPoints.length], true);
}
console.log(\`Gridshell roof: \${lathCount} laths + \${ringPoints.length} ring segments\`);

const result = bim.create.toIfc(h);
console.log(
  \`Created \${result.entities.length} entities, \${result.stats.entityCount} STEP lines, \` +
  \`\${(result.stats.fileSize / 1024).toFixed(1)} KB\`,
);
bim.model.loadIfc(result.content, 'sample-building.ifc');
bim.export.download(result.content, 'sample-building.ifc', 'application/x-step');
`,u=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ─────────────────────────────────────────────────────────────────────────
// Construction schedule — build an IfcWorkSchedule + IfcTasks + sequences
//
// Two modes:
//   1) Attach a construction sequence to the CURRENTLY LOADED model.
//      The script reads CSV task rows (attached via the chat paperclip)
//      and creates IfcTasks whose products are resolved by name/type.
//
//   2) No model loaded — generate a standalone demo IFC file with a few
//      walls and a matching 4-task construction schedule.
//
// CSV expected columns (case-insensitive, any subset works):
//   id, name, start, finish, duration, predecessor, products, predefinedType,
//   isMilestone, isCritical, completion
//
// Dates are ISO 8601 (e.g. 2024-05-01T08:00:00).
// Durations are ISO 8601 (e.g. P5D, PT8H).
// \`products\` is a comma-separated list of IFC types (e.g. "IfcWall,IfcSlab")
// OR entity globalIds; elements matching each row are assigned to that task.
// \`predecessor\` is the \`id\` of the row that must finish before this one.
// ─────────────────────────────────────────────────────────────────────────

function toIso(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  // Accept "YYYY-MM-DD" → append midnight
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return \`\${s}T00:00:00\`
  return s
}

function toBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
  return undefined
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// Canonicalize a column name so "Start Date", "start_date" and "start" all match.
function findCol(cols: string[], ...aliases: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[\\s_-]+/g, '')
  const wanted = aliases.map(norm)
  for (const c of cols) if (wanted.includes(norm(c))) return c
  return null
}

const files = bim.files.list()
const csvFile = files.find((f) => f.name.toLowerCase().endsWith('.csv'))

if (csvFile) {
  // ─── Mode 1: attach schedule to currently loaded model ────────────────
  const rows = bim.files.csv(csvFile.name) ?? []
  const cols = bim.files.csvColumns(csvFile.name)
  if (rows.length === 0) {
    console.warn(\`[schedule] \${csvFile.name} has no rows\`)
  } else {
    console.log(\`[schedule] loading \${rows.length} tasks from \${csvFile.name}\`)
  }

  const idCol = findCol(cols, 'id', 'taskid')
  const nameCol = findCol(cols, 'name', 'task', 'activity')
  const startCol = findCol(cols, 'start', 'startdate', 'schedulestart')
  const finishCol = findCol(cols, 'finish', 'end', 'enddate', 'schedulefinish')
  const durCol = findCol(cols, 'duration', 'scheduleduration')
  const predCol = findCol(cols, 'predecessor', 'depends', 'dependson')
  const productsCol = findCol(cols, 'products', 'type', 'entities', 'targets')
  const typeCol = findCol(cols, 'predefinedtype', 'kind')
  const mileCol = findCol(cols, 'ismilestone', 'milestone')
  const critCol = findCol(cols, 'iscritical', 'critical')
  const compCol = findCol(cols, 'completion', 'percentcomplete', 'progress')

  // Discover every loaded product once so we can resolve \`products\` values
  // (IFC type OR globalId substring) into a list of expressIds.
  const allProducts = bim.query.byType(
    'IfcWall', 'IfcSlab', 'IfcColumn', 'IfcBeam', 'IfcRoof', 'IfcStair',
    'IfcDoor', 'IfcWindow', 'IfcRailing', 'IfcFooting', 'IfcCurtainWall',
    'IfcMember', 'IfcPlate', 'IfcFurnishingElement', 'IfcBuildingElementProxy',
  )

  // Minimum character count before we fall back to a globalId prefix match;
  // avoids accidental wildcarding when the CSV column holds short tokens.
  const MIN_GID_PREFIX_LEN = 4

  function resolveProducts(spec: string | undefined): number[] {
    if (!spec) return []
    const parts = spec.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    const ids = new Set<number>()
    for (const part of parts) {
      const upper = part.toUpperCase()
      if (upper.startsWith('IFC')) {
        // IFC type — match all loaded entities of that class
        for (const e of allProducts) {
          if (e.Type.toUpperCase() === upper) ids.add(e.ref.expressId)
        }
      } else {
        // Exact globalId match, OR prefix match when the token is long enough
        // to uniquely identify an element (≥ 4 chars).
        for (const e of allProducts) {
          if (e.GlobalId === part) {
            ids.add(e.ref.expressId)
          } else if (part.length >= MIN_GID_PREFIX_LEN && e.GlobalId.startsWith(part)) {
            ids.add(e.ref.expressId)
          }
        }
      }
    }
    return Array.from(ids)
  }

  // We can't use bim.create on an existing model in this iteration — the
  // creator produces a fresh IFC file. So we log what *would* be created
  // and print a plan. The plan is directly feedable to a follow-up
  // save/export workflow.
  console.log('[schedule] plan:')
  for (const row of rows) {
    const id = idCol ? row[idCol] : '-'
    const name = nameCol ? row[nameCol] : '(unnamed)'
    const start = startCol ? toIso(row[startCol]) : undefined
    const finish = finishCol ? toIso(row[finishCol]) : undefined
    const dur = durCol ? row[durCol] : undefined
    const pred = predCol ? row[predCol] : undefined
    const prodSpec = productsCol ? row[productsCol] : undefined
    const prodIds = resolveProducts(prodSpec)
    const predefinedType = typeCol ? row[typeCol] : undefined
    const isMilestone = mileCol ? toBool(row[mileCol]) : undefined
    const isCritical = critCol ? toBool(row[critCol]) : undefined
    const completion = compCol ? toNumber(row[compCol]) : undefined
    console.log(
      \`  • [\${id}] \${name}  \${start ?? '?'} → \${finish ?? dur ?? '?'}  \` +
      \`prod=\${prodIds.length}  pred=\${pred ?? '-'}  \` +
      \`type=\${predefinedType ?? '-'}  mile=\${isMilestone ?? '-'}  \` +
      \`crit=\${isCritical ?? '-'}  comp=\${completion ?? '-'}\`,
    )
  }
  console.log(
    '[schedule] Attaching tasks to an existing IFC requires a separate ' +
    'mutation workflow — ask the assistant to wire the plan into a fresh ' +
    'IFC export using bim.create.* so the 4D Gantt panel can play it.',
  )
} else {
  // ─── Mode 2: generate a demo IFC with walls + a matching schedule ─────
  console.log('[schedule] No CSV attached — building demo model + schedule')

  const h = bim.create.project({ Name: 'Demo with schedule', Schema: 'IFC4' })
  const storey = bim.create.addIfcBuildingStorey(h, { Name: 'Ground', Elevation: 0 })

  const wallA = bim.create.addIfcWall(h, storey, {
    Name: 'Wall A', Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3,
  })
  const wallB = bim.create.addIfcWall(h, storey, {
    Name: 'Wall B', Start: [5, 0, 0], End: [5, 5, 0], Thickness: 0.2, Height: 3,
  })
  const wallC = bim.create.addIfcWall(h, storey, {
    Name: 'Wall C', Start: [5, 5, 0], End: [0, 5, 0], Thickness: 0.2, Height: 3,
  })
  const wallD = bim.create.addIfcWall(h, storey, {
    Name: 'Wall D', Start: [0, 5, 0], End: [0, 0, 0], Thickness: 0.2, Height: 3,
  })

  const schedule = bim.create.addIfcWorkSchedule(h, {
    Name: 'Construction schedule',
    StartTime: '2024-05-01T08:00:00',
    FinishTime: '2024-05-20T17:00:00',
    PredefinedType: 'PLANNED',
  })

  const tFoundation = bim.create.addIfcTask(h, {
    Name: 'Site preparation',
    PredefinedType: 'CONSTRUCTION',
    ScheduleStart: '2024-05-01T08:00:00',
    ScheduleFinish: '2024-05-03T17:00:00',
    ScheduleDuration: 'P3D',
    IsMilestone: false,
  })
  const tWallAB = bim.create.addIfcTask(h, {
    Name: 'Install walls A+B',
    PredefinedType: 'INSTALLATION',
    ScheduleStart: '2024-05-06T08:00:00',
    ScheduleFinish: '2024-05-10T17:00:00',
    ScheduleDuration: 'P5D',
  })
  const tWallCD = bim.create.addIfcTask(h, {
    Name: 'Install walls C+D',
    PredefinedType: 'INSTALLATION',
    ScheduleStart: '2024-05-13T08:00:00',
    ScheduleFinish: '2024-05-17T17:00:00',
    ScheduleDuration: 'P5D',
    IsCritical: true,
  })
  const tHandover = bim.create.addIfcTask(h, {
    Name: 'Handover',
    PredefinedType: 'CONSTRUCTION',
    ScheduleStart: '2024-05-20T08:00:00',
    ScheduleFinish: '2024-05-20T17:00:00',
    IsMilestone: true,
  })

  bim.create.assignTasksToWorkSchedule(h, schedule, [tFoundation, tWallAB, tWallCD, tHandover])
  bim.create.assignProductsToTask(h, tWallAB, [wallA, wallB])
  bim.create.assignProductsToTask(h, tWallCD, [wallC, wallD])

  bim.create.addIfcRelSequence(h, tFoundation, tWallAB, { SequenceType: 'FINISH_START', TimeLag: 'P2D' })
  bim.create.addIfcRelSequence(h, tWallAB, tWallCD, { SequenceType: 'FINISH_START' })
  bim.create.addIfcRelSequence(h, tWallCD, tHandover, { SequenceType: 'FINISH_START' })

  const result = bim.create.toIfc(h)
  console.log(\`[schedule] generated \${result.stats.entityCount} entities (\${result.stats.fileSize} bytes)\`)
  bim.export.download(result.content, 'demo-with-schedule.ifc', 'model/ifc')
  console.log('[schedule] downloaded demo-with-schedule.ifc — open it in this viewer to see the 4D Gantt panel animate the construction.')
}
`,d=`/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ── Cost report (IFC 5D) ────────────────────────────────────────────────
// Stakeholder: Cost Estimator / Quantity Surveyor
//
// Reads the loaded model's IfcCostSchedule / IfcCostItem graph through
// \`bim.cost\` (the same read model the viewer's Cost panel uses — see
// docs/guide/cost-panel.md) and prints a per-item report: resolved amount
// and currency, or — when a value could not be evaluated — the evaluator's
// own diagnostic, never a guess. Exports a JSON report alongside the console
// report.
//
// This script is READ-ONLY: \`bim.cost\` has no write/author methods.
// Spreadsheet-style cost editing is out of scope for the viewer's Cost
// panel and for this template.
// ─────────────────────────────────────────────────────────────────────────

const data = bim.cost.data()

if (!data.HasCostData) {
  // Genuinely no cost data — NOT the same as "the read failed". \`bim.cost\`
  // never conflates the two; neither does this report.
  console.log('[cost] this model has no IfcCostItem/IfcCostSchedule data.')
} else {
  console.log(\`[cost] schema \${data.SchemaVersion} — \${data.CostSchedules.length} schedule(s), \${data.CostItems.length} cost item(s)\`)

  if (data.Currency) {
    console.log(\`[cost] project currency: \${data.Currency}\`)
  } else {
    const mixedCurrency = data.Diagnostics.some((d) => d.Code === 'MIXED_CURRENCY')
    console.log(mixedCurrency
      ? '[cost] WARNING: the project declares more than one currency — amounts below are never summed across currencies.'
      : '[cost] no project currency declared.')
  }

  // Kept in sync with the Cost panel's own \`CYCLE_CODES_LIST\`
  // (apps/viewer/src/lib/cost/cost-tree.ts) — templates.ts substitutes the
  // real list into the literal below at template-build time (see the
  // CYCLE_CODES_INJECT marker and templates.test.ts's sync assertion), so
  // this file never hand-duplicates which diagnostic codes count as cyclic.
  const cycleCodes: string[] = ['NESTING_CYCLE'] // CYCLE_CODES_INJECT
  const cyclic = data.Diagnostics.some((d) => cycleCodes.includes(d.Code))
  if (cyclic) {
    console.log('[cost] WARNING: a cost item cycle was detected — see per-item diagnostics below.')
  }

  type Row = { id: string; name: string; identification: string; amount: string; currency: string; diagnostics: string }
  const rows: Row[] = []

  for (const item of data.CostItems) {
    const evaluation = bim.cost.evaluateItem(item.ref)
    const unresolved = evaluation.Amount === undefined
    const diagnosticText = evaluation.Diagnostics.map((d) => \`\${d.Code}: \${d.Message}\`).join(' | ')
    console.log(
      unresolved
        ? \`  ✗ #\${item.ref.expressId} \${item.Name ?? '(unnamed)'} — unresolved\${diagnosticText ? \` (\${diagnosticText})\` : ''}\`
        : \`  ✓ #\${item.ref.expressId} \${item.Name ?? '(unnamed)'} — \${evaluation.Amount}\${evaluation.Currency ? \` \${evaluation.Currency}\` : ''}\`,
    )
    rows.push({
      id: String(item.ref.expressId),
      name: item.Name ?? '',
      identification: item.Identification ?? '',
      amount: evaluation.Amount ?? '',
      currency: evaluation.Currency ?? '',
      diagnostics: diagnosticText,
    })
  }

  // JSON, not CSV: \`bim.export.csv()\`/\`bim.export.json()\` resolve columns from an
  // entity's property/quantity sets (\`SetName.ValueName\`), and these rows carry
  // \`bim.cost.evaluateItem()\` results instead — a resolved amount, currency and
  // diagnostics text with no backing pset/qset to point a column path at. Rolling
  // a CSV writer by hand here would just be an eighth escaper (the repo caps this
  // at exactly one per language — see \`scripts/check-csv-escaper-copies.mjs\`), so
  // this template hands the report to \`bim.export.download()\` as JSON, which
  // needs no escaping of its own: \`JSON.stringify\` already quotes every value.
  const json = JSON.stringify(rows, null, 2)

  bim.export.download(json, 'cost-report.json', 'application/json')
  console.log(\`[cost] exported cost-report.json (\${rows.length} row(s))\`)
}
`;function f(e){return e.replace(/^export \{\}[^\n]*\n\n?/m,``)}function p(t){let n=/const cycleCodes: string\[\] = \[[^\]]*\] \/\/ CYCLE_CODES_INJECT/;if(!n.test(t))throw Error(`cost-report.ts: CYCLE_CODES_INJECT marker not found — template/cost-tree.ts sync is broken`);return t.replace(n,`const cycleCodes: string[] = ${JSON.stringify(e)} // CYCLE_CODES_INJECT`)}var m=[{name:`Data quality audit`,description:`BIM Manager — scan all entities for missing names, properties, and quantities; score model completeness; color-code by data quality`,code:f(t)},{name:`Fire safety compliance`,description:`Architect — check fire ratings across walls, doors, and slabs; flag load-bearing elements without ratings; export non-compliant list`,code:f(n)},{name:`Quantity takeoff`,description:`Cost Estimator — aggregate area, volume, and length quantities across all element types; generate material takeoff table and CSV`,code:f(r)},{name:`Envelope & thermal check`,description:`Energy Consultant — identify external elements, check thermal transmittance values, isolate building envelope, flag missing data`,code:f(i)},{name:`MEP equipment schedule`,description:`HVAC Engineer — discover all distribution elements, extract equipment properties, generate schedule, isolate and color by system`,code:f(a)},{name:`Space & room validation`,description:`Facility Manager — validate IfcSpace entities for area, volume, naming; generate room schedule with totals; flag incomplete spaces`,code:f(o)},{name:`Federation comparison`,description:`Project Manager — compare multiple loaded models side by side: entity counts, type coverage, naming consistency, coordination issues`,code:f(s)},{name:`Create building (IFC from scratch)`,description:`Developer — generate a complete IFC file with walls, slab, columns, beams, stair, and parametric timber gridshell roof with diamond lattice`,code:f(l)},{name:`Construction schedule (4D)`,description:`Scheduler — build an IfcWorkSchedule with IfcTasks, IfcRelSequence dependencies, and product assignments that drive the 4D Gantt animation. Accepts a CSV attachment for real task data.`,code:f(u)},{name:`Cost report (5D)`,description:`Cost Estimator — read the loaded IfcCostSchedule/IfcCostItem graph via bim.cost, print resolved amounts (or diagnostics for what could not be evaluated), and download the report as JSON. Read-only.`,code:f(p(d))},{name:`Reset view`,description:`Utility — remove all color overrides and show all entities`,code:f(c)}];export{f as n,m as t};