/**
 * Geometry of a junction drawn with a circle on the map: where the circuit lanes meet the circle (their ports), how the
 * connections inside are drawn, and how large the circle has to be for that. Pure functions on layer pixels; the map
 * editor draws the result.
 */
import L from 'leaflet'

/**
 * Cuts the start of a polyline (layer pixels) where it leaves the circle of
 * radius `r` around `center`: the part inside is dropped and the crossing
 * becomes the new first point. Undefined when the line never leaves the circle.
 */
export function trimStartAtCircle(p: L.Point[], center: L.Point, r: number): { points: L.Point[]; port: L.Point; dir: L.Point } | undefined {
    for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1]
        if (b.distanceTo(center) < r) continue
        // a + t (b - a) on the circle; the larger root is where the segment leaves it
        const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - center.x, fy = a.y - center.y
        const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r
        const disc = B * B - 4 * A * C
        if (A === 0 || disc < 0) return undefined
        const t = Math.min(1, Math.max(0, (-B + Math.sqrt(disc)) / (2 * A)))
        const port = L.point(a.x + dx * t, a.y + dy * t)
        const len = Math.sqrt(A)
        return {points: [port, ...p.slice(i + 1)], port, dir: L.point(-dx / len, -dy / len)}
    }
    return undefined
}

/** Whether two polylines (layer pixels) cross. */
export function polylinesCross(p: L.Point[], q: L.Point[]): boolean {
    const side = (a: L.Point, b: L.Point, c: L.Point) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
    for (let i = 0; i < p.length - 1; i++) for (let j = 0; j < q.length - 1; j++) {
        const a = p[i], b = p[i + 1], c = q[j], d = q[j + 1]
        if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true
    }
    return false
}

/** A circuit end running into a junction circle: its lane (layer px) from the junction outward, its lane group (path) and width. */
export interface JunctionArrival {
    key: string
    group: string
    px: L.Point[]
    weight: number
}

/** Where an arrival meets the circle: the port and the direction into the circle. */
export interface JunctionPort {
    key: string
    group: string
    point: L.Point
    dir: L.Point
    weight: number
}

/** How a connection at a junction is drawn: one polyline (layer px) per circuit end (`key`), and the dot of a node of three or more ends. */
export interface JunctionDrawing {
    lines: { key: string; pts: L.Point[] }[]
    dot?: L.Point
}

/** A connector whose way in and way out differ by less than this is one straight segment. */
const CONNECTOR_STRAIGHT_DEG = 3
/** A bundle turning less than this (a gentle bend) jogs onto the far lanes' lines at 45° instead of bending halfway at each of two corners. */
const CONNECTOR_GENTLE_DEG = 25
/** Gap (px) between the edges of connectors of different connections, and of the lanes of different paths where they meet the circle: they do not overlap. */
const CONNECTOR_GAP_PX = 1
/** A junction circle too small for its connectors grows by this much (px) per step, up to JUNCTION_GROW_MAX times its size from the lanes. */
const JUNCTION_GROW_STEP_PX = 1
const JUNCTION_GROW_MAX = 4

const dotP = (p: L.Point, q: L.Point) => p.x * q.x + p.y * q.y
const crossP = (p: L.Point, q: L.Point) => p.x * q.y - p.y * q.x
const unitP = (p: L.Point) => {
    const len = Math.hypot(p.x, p.y)
    return len > 1e-9 ? L.point(p.x / len, p.y / len) : L.point(0, 0)
}
/** The left of a direction, as `offsetPoints` takes it. */
const leftP = (v: L.Point) => L.point(v.y, -v.x)

/** How far along `u` from `p` the line `p + t·u` meets the line `q + w·v`; undefined when they are parallel. */
function meetAlong(p: L.Point, u: L.Point, q: L.Point, v: L.Point): number | undefined {
    const den = crossP(u, v)
    return Math.abs(den) < 1e-9 ? undefined : crossP(q.subtract(p), v) / den
}

/**
 * Connectors for joined pairs of circuit ends at one junction (ports on its circle), as straight segments with at most
 * two bends, none turning more than 90° (every corner at least a right angle): in along the lane, across, out along
 * the other lane. The pairs between the same two paths are a bundle: one route, each pair offset from it by its lanes'
 * place across the direction of travel, every leg on its own lane's line, so parallel connectors keep the lane spacing
 * and never touch (pairs whose lanes swap sides cross, as they must). How a bundle crosses:
 * - turning (more than CONNECTOR_GENTLE_DEG): two bends that each turn half the way;
 * - a gentle bend: one bend where the pair's lanes' lines meet (`gentleCorner`), so it turns only the way it turns; a
 *   pair whose lines meet outside the circle takes a 45° jog from the near lanes onto the far lanes' lines instead, and
 *   so does the whole bundle when single bends would cross more often than that;
 * - nearly straight (less than CONNECTOR_STRAIGHT_DEG): straight when the lanes line up, else a 45° jog across (each
 *   pair its own when they shift by different amounts).
 * Bends and jogs sit where the bundle has the circle to itself, so its long straight run lies parallel to the other
 * connectors of a shared path: near the circle on its own side when the far path also carries other connectors
 * (`groupSize` > the bundle) or neither does, near the far side when only the near path does, in between when both do.
 * Every leg is at least `minLeg` long; a route that cannot be built so is the straight segment between its ports.
 */
export function routeConnectorPairs(pairs: { id: string; a: JunctionPort; b: JunctionPort }[], spacing: number, groupSize: (group: string) => number = () => 0,
                                    circle?: { center: L.Point; r: number }): Map<string, L.Point[]> {
    const routes = new Map<string, L.Point[]>()
    const bundles = new Map<string, typeof pairs>()
    for (const p of pairs) {
        // a pair within one path (a loop back) is a bundle of its own; the others run from the group that sorts first
        const q = p.a.group > p.b.group ? {id: p.id, a: p.b, b: p.a} : p
        const key = p.a.group === p.b.group ? `self:${p.id}` : `${q.a.group}|${q.b.group}`
        bundles.set(key, [...(bundles.get(key) ?? []), q])
    }
    const minLeg = Math.max(2, spacing * 0.6)
    const straight = Math.cos(CONNECTOR_STRAIGHT_DEG * Math.PI / 180), gentle = Math.cos(CONNECTOR_GENTLE_DEG * Math.PI / 180)
    /**
     * A gentle bend (a pair turning between CONNECTOR_STRAIGHT_DEG and CONNECTOR_GENTLE_DEG) whose lanes' lines meet inside
     * the circle: one bend where they meet, so it turns only the way the pair turns. Undefined otherwise.
     */
    const gentleCorner = (x: typeof pairs[number]) => {
        const turn = -dotP(x.a.dir, x.b.dir)
        if (turn >= straight || turn < gentle) return undefined
        const t1 = meetAlong(x.a.point, x.a.dir, x.b.point, x.b.dir), t2 = meetAlong(x.b.point, x.b.dir, x.a.point, x.a.dir)
        if (t1 === undefined || t2 === undefined || t1 <= 0 || t2 <= 0 || (!circle && Math.min(t1, t2) < minLeg)) return undefined
        const corner = x.a.point.add(x.a.dir.multiplyBy(t1))
        return !circle || corner.distanceTo(circle.center) <= circle.r - Math.max(x.a.weight, x.b.weight) / 2 ? corner : undefined
    }
    /** Routes for `list`, pairs of one bundle of `bundleSize` routed together (see the function comment). */
    const routeBundle = (list: typeof pairs, bundleSize: number): Map<string, L.Point[]> => {
        const routes = new Map<string, L.Point[]>()
        const mean =(f: (x: typeof list[number]) => L.Point) => list.reduce((s, x) => s.add(f(x)), L.point(0, 0)).divideBy(list.length)
        const a = unitP(mean(x => x.a.dir)), out = unitP(mean(x => x.b.dir)).multiplyBy(-1)
        const ca = mean(x => x.a.point), cb = mean(x => x.b.point)
        const straightAll = () => list.forEach(x => routes.set(x.id, [x.a.point, x.b.point]))
        const toward = cb.subtract(ca)
        // a side whose path also carries other connectors: the bundle bends or jogs away from it, so its long straight
        // run there lies parallel to them
        const sharedA = groupSize(list[0].a.group) > bundleSize, sharedB = groupSize(list[0].b.group) > bundleSize
        /** Direction of the middle, and the depth the bundle would like its first bend at (undefined: as shallow as it can). */
        let m: L.Point, preferred: number | undefined
        if (dotP(a, out) >= straight) {
            // how far each pair's far port lies off its near lane's line
            const shifts = list.map(x => dotP(x.b.point.subtract(x.a.point), leftP(a)))
            const shift = dotP(toward, leftP(a))
            const room = dotP(toward, a) - Math.abs(shift) - 2 * minLeg
            if (shifts.every(d => Math.abs(d) < 0.5) || room < 0) {
                straightAll()
                return routes
            }
            /** Where a jog goes in the room a pair or the bundle has: near the side its path has to itself. */
            const jogAt = (free: number) => minLeg + (sharedB && !sharedA ? 0 : sharedA && !sharedB ? free : free / 2)
            if (Math.abs(shift) < 0.5 || Math.max(...shifts) - Math.min(...shifts) > spacing / 2) {
                // the pairs shift by different amounts (some cross): each runs along its own lanes and shifts across in a
                // 45° jog of its own, at the same place as a bundle's jog; the ends stay parallel to their neighbours
                list.forEach(x => {
                    // in along the near lane, a 45° jog towards the far lane's line, then along that line into its port
                    const off = dotP(x.b.point.subtract(x.a.point), leftP(x.a.dir))
                    if (Math.abs(off) < 0.5) return routes.set(x.id, [x.a.point, x.b.point])
                    const jog = unitP(x.a.dir.add(leftP(x.a.dir).multiplyBy(Math.sign(off))))
                    /** The jog started `l1` along the near lane: how long it is, and how far from the far port it meets its line. */
                    const at = (l1: number) => {
                        const q1 = x.a.point.add(x.a.dir.multiplyBy(l1))
                        return {q1, k: meetAlong(q1, jog, x.b.point, x.b.dir), u: meetAlong(x.b.point, x.b.dir, q1, jog)}
                    }
                    const s0 = at(minLeg), s1 = at(minLeg + 1)
                    if (s0.u === undefined || s1.u === undefined || s0.k === undefined || s0.k < 0) return routes.set(x.id, [x.a.point, x.b.point])
                    // the far leg shrinks evenly as the jog moves along: the room is where it stays at least minLeg
                    const slope = s1.u - s0.u
                    const free = slope < -1e-6 ? (minLeg - s0.u) / slope : 0
                    if (s0.u < minLeg || free < 0) return routes.set(x.id, [x.a.point, x.b.point])
                    const {q1, u} = at(jogAt(free))
                    routes.set(x.id, tidyRoute(u === undefined ? [x.a.point, x.b.point] : [x.a.point, q1, x.b.point.add(x.b.dir.multiplyBy(u)), x.b.point]))
                })
                return routes
            }
            m = unitP(a.add(leftP(a).multiplyBy(Math.sign(shift))))
            preferred = jogAt(room)
        } else {
            // a gentle bend whose lanes' lines meet outside the circle (lanes shifted across, see gentleCorner): a 45° jog
            // from the near lanes onto the far lanes' lines, where the bundle bends (see below), so it runs along the far
            // lanes from there; the jog goes towards the side the far lanes' line lies at that place
            let jogSide = 0
            if (dotP(a, out) >= gentle) {
                const along = dotP(toward, a)
                const where = sharedA && !sharedB ? along - minLeg : sharedA && sharedB ? along / 2 : minLeg
                const bIn = unitP(mean(x => x.b.dir))
                const u = (where - along) / dotP(bIn, a)
                const side = dotP(cb.add(bIn.multiplyBy(u)).subtract(ca), leftP(a))
                if (Math.abs(side) >= 0.5) jogSide = Math.sign(side)
            }
            if (jogSide) m = unitP(a.add(leftP(a).multiplyBy(jogSide)))
            else {
                // the middle runs halfway between the way in and the way out; on a U-turn straight across, towards the far ports
                m = a.add(out)
                if (Math.hypot(m.x, m.y) < 0.35 || dotP(m, toward) <= 0) {
                    const n = leftP(a)
                    m = dotP(n, toward) >= 0 ? n : n.multiplyBy(-1)
                } else m = unitP(m)
            }
        }
        // each pair's place across the direction of travel (an offset route keeps it): at the near ports, the far ports, in between
        const offsets = list.map(x => (dotP(x.a.point.subtract(ca), leftP(a)) + dotP(x.b.point.subtract(cb), leftP(out))) / 2)
        /** Leg lengths (along each port's direction) of a pair, with the bundle's first bend at depth `s` along `a`. */
        const legs = (i: number, s: number) => {
            const x = list[i]
            const mid = ca.add(a.multiplyBy(s)).add(leftP(m).multiplyBy(offsets[i]))
            const t1 = meetAlong(x.a.point, x.a.dir, mid, m), t2 = meetAlong(x.b.point, x.b.dir, mid, m)
            return t1 === undefined || t2 === undefined ? undefined : {t1, t2}
        }
        // the depths that leave every leg at least minLeg (each leg changes evenly with the depth)
        let lo = 0, hi = Infinity, ok = true
        for (let i = 0; i < list.length && ok; i++) {
            const l0 = legs(i, 0), l1 = legs(i, 1)
            if (!l0 || !l1) ok = false
            else for (const [t0, t1] of [[l0.t1, l1.t1], [l0.t2, l1.t2]]) {
                const k = t1 - t0
                if (Math.abs(k) < 1e-6) ok = ok && t0 >= minLeg
                else if (k > 0) lo = Math.max(lo, (minLeg - t0) / k)
                else hi = Math.min(hi, (minLeg - t0) / k)
            }
        }
        if (!ok || lo > hi) {
            straightAll()
            return routes
        }
        // a turning bundle bends near the side its path has to itself: near the circle when the far side is shared (or
        // neither is), deep in when only the near side is, in between when both are
        if (preferred === undefined && Number.isFinite(hi)) preferred = sharedA && !sharedB ? hi : sharedA && sharedB ? (lo + hi) / 2 : lo
        const s = preferred === undefined ? lo : Math.min(hi, Math.max(lo, preferred))
        list.forEach((x, i) => {
            const l = legs(i, s)
            const q1 = l && x.a.point.add(x.a.dir.multiplyBy(l.t1)), q2 = l && x.b.point.add(x.b.dir.multiplyBy(l.t2))
            // bends that would run backwards: the straight segment
            routes.set(x.id, tidyRoute(l && q1 && q2 && l.t1 >= 0 && l.t2 >= 0 && dotP(q2.subtract(q1), m) >= -0.5 ? [x.a.point, q1, q2, x.b.point] : [x.a.point, x.b.point]))
        })
        return routes
    }
    /** How many pairs of the given routes cross. */
    const crossings = (r: Map<string, L.Point[]>) => {
        const all = [...r.values()]
        let n = 0
        for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (polylinesCross(all[i], all[j])) n++
        return n
    }
    for (const bundle of bundles.values()) {
        // gentle bends that can turn once do (the meeting points of parallel pairs lie on one line across the bundle, so
        // those connectors stay parallel) and the others are routed as a bundle, unless that crosses more often than
        // routing them all as a bundle (pairs whose lanes swap sides meet far apart)
        const together = routeBundle(bundle, bundle.length)
        const corners = new Map(bundle.map(x => [x.id, gentleCorner(x)] as const))
        let chosen = together
        if (bundle.some(x => corners.get(x.id))) {
            const rest = bundle.filter(x => !corners.get(x.id))
            const turned = rest.length ? routeBundle(rest, bundle.length) : new Map<string, L.Point[]>()
            for (const x of bundle) {
                const corner = corners.get(x.id)
                if (corner) turned.set(x.id, [x.a.point, corner, x.b.point])
            }
            if (crossings(turned) <= crossings(together)) chosen = turned
        }
        chosen.forEach((pts, id) => routes.set(id, pts))
    }
    return routes
}

/**
 * A connector's polyline made sound: two bends less than 1 px apart (a pair that barely shifts in its bundle's jog)
 * become one, and a route with a bend turning more than 90° (a corner sharper than a right angle) is the straight
 * segment between its ports instead.
 */
function tidyRoute(pts: L.Point[]): L.Point[] {
    const route = pts.length === 4 && pts[1].distanceTo(pts[2]) < 1 ? [pts[0], pts[1].add(pts[2]).divideBy(2), pts[3]] : pts
    for (let k = 1; k + 1 < route.length; k++) {
        if (dotP(route[k].subtract(route[k - 1]), route[k + 1].subtract(route[k])) < -1e-6) return [route[0], route[route.length - 1]]
    }
    return route
}

/** Smallest distance between a point and a segment. */
function pointSegmentGap(p: L.Point, a: L.Point, b: L.Point): number {
    const ab = b.subtract(a), len2 = dotP(ab, ab)
    const t = len2 ? Math.max(0, Math.min(1, dotP(p.subtract(a), ab) / len2)) : 0
    return p.distanceTo(a.add(ab.multiplyBy(t)))
}

/** Smallest distance between two polylines that do not cross. */
export function polylineGap(p: L.Point[], q: L.Point[]): number {
    let best = Infinity
    for (let i = 0; i + 1 < p.length; i++) for (let j = 0; j + 1 < q.length; j++) {
        best = Math.min(best, pointSegmentGap(p[i], q[j], q[j + 1]), pointSegmentGap(p[i + 1], q[j], q[j + 1]), pointSegmentGap(q[j], p[i], p[i + 1]), pointSegmentGap(q[j + 1], p[i], p[i + 1]))
    }
    return best
}

/**
 * One junction drawn with a circle: its radius and how each connection there is drawn. The lanes stop on the circle;
 * joined pairs get `routeConnectorPairs`; a node of three or more ends (or one whose other ends are not drawn) gets a
 * spoke from each port, in along its lane and then straight, to a dot between the ports and the centre (one drawn end:
 * just inside its port). With `grow`, the circle grows from `r0` (by JUNCTION_GROW_STEP_PX, up to JUNCTION_GROW_MAX
 * times) while that leaves fewer places where connectors of different connections overlap without crossing, bends
 * leave the circle, or the lanes of different paths overlap at its edge: it keeps the smallest radius with the fewest,
 * so it is just large enough. Without (zoomed out), it keeps `r0` and connectors may overlap.
 */
export function layoutJunction(center: L.Point, r0: number, arrivals: JunctionArrival[], connections: { id: string; keys: string[] }[], spacing: number,
                               grow = true): { radius: number; drawings: Map<string, JunctionDrawing> } {
    /** The distance (centre to centre) two lines of widths `a` and `b` keep so they do not overlap. */
    const need = (a: number, b: number) => (a + b) / 2 + CONNECTOR_GAP_PX
    const layout = (r: number) => {
        const ports = new Map<string, JunctionPort>()
        for (const a of arrivals) {
            const cut = trimStartAtCircle(a.px, center, r)
            if (cut) ports.set(a.key, {key: a.key, group: a.group, point: cut.port, dir: cut.dir, weight: a.weight})
        }
        const pairs = connections.filter(c => c.keys.length === 2 && ports.has(c.keys[0]) && ports.has(c.keys[1]))
            .map(c => ({id: c.id, a: ports.get(c.keys[0])!, b: ports.get(c.keys[1])!}))
        const sizes = new Map<string, number>()
        for (const p of ports.values()) sizes.set(p.group, (sizes.get(p.group) ?? 0) + 1)
        const pairRoutes = routeConnectorPairs(pairs, spacing, g => sizes.get(g) ?? 0, {center, r})
        const drawings = new Map<string, JunctionDrawing>()
        for (const c of connections) {
            const here = c.keys.map(k => ports.get(k)).filter((p): p is JunctionPort => !!p)
            if (!here.length) continue
            const route = pairRoutes.get(c.id)
            if (route) {
                drawings.set(c.id, {lines: [{key: here[0].key, pts: route}]})
                continue
            }
            // a node holding one drawn end (an open end): its dot one lane spacing inside the port, clear of the connectors across the circle
            const dot = here.length === 1 ? here[0].point.add(here[0].dir.multiplyBy(Math.min(r * 0.5, spacing)))
                : here.reduce((s, p) => s.add(p.point), L.point(0, 0)).divideBy(here.length).add(center).divideBy(2)
            drawings.set(c.id, {
                dot, lines: here.map(p => {
                    const bend = p.point.add(p.dir.multiplyBy(Math.min(spacing, p.point.distanceTo(dot) / 2)))
                    // the bend turns at most 90°, else the spoke runs straight from the port
                    return {key: p.key, pts: dotP(dot.subtract(bend), p.dir) >= 0 ? [p.point, bend, dot] : [p.point, dot]}
                }),
            })
        }
        // where it is crowded
        let crowded = 0
        const lines = [...drawings].flatMap(([id, d]) => d.lines.map(l => ({id, pts: l.pts, w: ports.get(l.key)!.weight})))
        for (const l of lines) for (const v of l.pts.slice(1, -1)) if (v.distanceTo(center) > r - l.w / 2 + 0.01) crowded++
        for (const d of drawings.values()) if (d.dot && d.dot.distanceTo(center) > r) crowded++
        const ps = [...ports.values()]
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
            if (ps[i].group !== ps[j].group && ps[i].point.distanceTo(ps[j].point) < need(ps[i].weight, ps[j].weight)) crowded++
        }
        for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
            if (lines[i].id === lines[j].id || polylinesCross(lines[i].pts, lines[j].pts)) continue
            if (polylineGap(lines[i].pts, lines[j].pts) < need(lines[i].w, lines[j].w)) crowded++
        }
        return {radius: r, drawings, crowded}
    }
    let best = layout(r0)
    for (let r = r0 + JUNCTION_GROW_STEP_PX; grow && best.crowded > 0 && r <= r0 * JUNCTION_GROW_MAX + 1e-9; r += JUNCTION_GROW_STEP_PX) {
        const next = layout(r)
        if (next.crowded < best.crowded) best = next
    }
    return {radius: best.radius, drawings: best.drawings}
}
