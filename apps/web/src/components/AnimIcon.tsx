/**
 * Icons whose parts carry a scene.
 *
 * Drawn rather than taken from the library, because the animation decides the geometry:
 * a bank that separates in depth needs three banks, a pocket that takes a coin needs a
 * pocket. Same language as the rest — one colour, one stroke weight, 24px grid, round
 * caps, nothing filled.
 *
 * Movement lives in the stylesheet, keyed off `data-part`, so hovering the control that
 * holds the icon drives it and leaving reverses it.
 */

export type AnimName =
  | 'portfolio' | 'accounts' | 'income' | 'expenses'
  | 'gold' | 'stocks' | 'zakat' | 'settings' | 'flow' | 'assets'
  | 'dashboards' | 'budgets' | 'logs' | 'debts'
  | 'charity' | 'hands' | 'realestate';

const COMMON = {
  fill: 'none' as const,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function AnimIcon({ name, size = 17, color = 'currentColor', strokeWidth = 1.75 }: {
  name: AnimName; size?: number; color?: string; strokeWidth?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" stroke={color} strokeWidth={strokeWidth}
         className={`ico anim anim-${name}`} aria-hidden="true" {...COMMON}>
      {SCENES[name]}
    </svg>
  );
}

const SCENES: Record<AnimName, React.ReactNode> = {
  /**
   * The pie the overview itself draws, seen from a low angle rather than straight down.
   *
   * The circle is an ellipse and every wedge carries the side of the pie underneath it, so
   * the mark has a thickness: a rim that is visible on the near half and hidden behind the
   * far half, which is the only honest way to draw a solid from one side. The top faces are
   * stroked like the rest of the set; the rim is filled and unstroked, because a stroke at
   * this weight would close a band under three pixels tall into a solid bar.
   *
   * Four wedges, none of them the same size — 135, 85, 75 and 65 degrees. Equal quarters
   * read as a crosshair, and near-equal ones read as an accident; these read as shares.
   * Their fills differ too, so the four are told apart by tone and not only by the cuts.
   *
   * They are drawn back to front — the far wedge, then the two at the sides, then the near
   * one — so the near rim covers what sits behind it. Hovering pulls each wedge out along
   * its own bisector, flattened by the same amount as the ellipse so they travel in the
   * plane of the pie rather than across the screen: the slices of a pizza coming apart.
   */
  portfolio: (
    <g strokeWidth="1.35">
      {/* What the solid stands on. A disc this faint is not a shadow anyone reads as a
          shadow; it is the reason the pie sits on the grid instead of floating in it. */}
      <ellipse cx="12" cy="19.7" rx="7.4" ry="1.4"
               stroke="none" fill="currentColor" fillOpacity="0.055" />
      {/* the far wedge shows no rim: its own top face stands in front of it */}
      <g data-part="s4">
        <path d="M12 11.4 4.39 8.63A8.4 6.55 0 0 1 12 4.85Z" fill="currentColor" fillOpacity="0.08" />
      </g>
      <g data-part="s1">
        <path d="M20.4 11.4A8.4 6.55 0 0 1 17.94 16.03L17.94 18.33A8.4 6.55 0 0 0 20.4 13.7Z"
              stroke="none" fill="currentColor" fillOpacity="0.4" />
        <path d="M12 11.4 12 4.85A8.4 6.55 0 0 1 17.94 16.03Z" fill="currentColor" fillOpacity="0.2" />
      </g>
      <g data-part="s3">
        <path d="M6.6 16.42A8.4 6.55 0 0 1 3.6 11.4L3.6 13.7A8.4 6.55 0 0 0 6.6 18.72Z"
              stroke="none" fill="currentColor" fillOpacity="0.44" />
        <path d="M12 11.4 6.6 16.42A8.4 6.55 0 0 1 4.39 8.63Z" fill="currentColor" fillOpacity="0.3" />
      </g>
      <g data-part="s2">
        <path d="M17.94 16.03A8.4 6.55 0 0 1 6.6 16.42L6.6 18.72A8.4 6.55 0 0 0 17.94 18.33Z"
              stroke="none" fill="currentColor" fillOpacity="0.34" />
        <path d="M12 11.4 17.94 16.03A8.4 6.55 0 0 1 6.6 16.42Z" fill="currentColor" fillOpacity="0.13" />
      </g>
      {/* The bevel: the seam where the top faces meet the side, on the near half only,
          because that is the only half whose side you can see. One stroke, a little
          brighter than the wedge outlines, which is the whole of the "dimensional" claim —
          a glow would say the same thing louder and be wrong in both themes. */}
      <path data-part="bevel" d="M3.6 11.4A8.4 6.55 0 0 0 20.4 11.4"
            strokeWidth="1.1" opacity="0.5" />
      {/* The surface. A polished solid lit from the upper left has one soft highlight and
          no more; it fades as the pie comes apart, because a broken surface has no gloss. */}
      <ellipse data-part="sheen" cx="9.5" cy="8.9" rx="4.4" ry="1.9"
               transform="rotate(-17 9.5 8.9)"
               stroke="none" fill="currentColor" fillOpacity="0.085" />
    </g>
  ),

  /**
   * Statistics: three columns that redraw themselves.
   *
   * The screen this opens compares one period against the one before it, so the bars do not
   * merely grow — one of them falls while the others rise, which is the thing the screen is
   * for. Each column scales from where it stands on the axis, so they stay planted while
   * their tops move.
   */
  dashboards: (
    <g>
      <path d="M3.4 20.6h17.2" />
      <rect data-part="b1" x="4.9" y="13.2" width="3.6" height="7.4" rx="1" />
      <rect data-part="b2" x="10.2" y="8.4" width="3.6" height="12.2" rx="1" />
      <rect data-part="b3" x="15.5" y="11.4" width="3.6" height="9.2" rx="1" />
    </g>
  ),

  /**
   * Money held in several places at once: three banks standing on a turning globe.
   *
   * The globe is a wireframe — a rim, an equator and one meridian — and the equator is an
   * ellipse 0.369 as tall as it is wide, the same low camera the pie is seen from. The banks
   * are placed inside that squash, so one at the side stands on the silhouette and one at
   * the front stands low on the near face, the way a building on a sphere does.
   *
   * Each bank then undoes the squash and the turn on itself. That cancellation is the whole
   * trick: without it the parent's scale and the orbit's rotation compose into a shear, and
   * a building would lean and stretch as it went round instead of standing up. What is left
   * is position — three upright banks travelling an ellipse.
   *
   * Depth is the second layer. A bank grows and darkens as it comes to the front and shrinks
   * and fades as it goes behind, on a cycle that is the same for all three and merely
   * started at a different point, which is what a fixed paint order cannot say on its own.
   * The meridian narrows to a line as the banks cross the poles, so the wireframe and the
   * buildings agree about which way the globe is facing.
   */
  accounts: (
    <g>
      <circle data-part="globe" cx="12" cy="12" r="8.4" />
      <ellipse data-part="equator" cx="12" cy="12" rx="8.4" ry="3.1" strokeWidth="1.15" opacity="0.34" />
      <ellipse data-part="meridian" cx="12" cy="12" rx="3.3" ry="8.4" strokeWidth="1.15" opacity="0.34" />
      <g transform="matrix(1 0 0 0.369 0 7.572)">
        <g data-part="orbit">
          <g transform="rotate(0 12 12)">
            <g data-part="mark">
              <g transform="rotate(0 19.6 12)">
                <g data-part="depth" opacity="0.72">
                  <g transform="matrix(1 0 0 2.71 0 -20.52)" strokeWidth="1.45">
                    <path d="M18.15 10.55 19.6 9.15 21.05 10.55" />
                    <path d="M18.85 11.05V12.2" />
                    <path d="M20.35 11.05V12.2" />
                    <path d="M18.05 12.55H21.15" />
                  </g>
                </g>
              </g>
            </g>
          </g>
          <g transform="rotate(120 12 12)">
            <g data-part="mark">
              <g transform="rotate(-120 19.6 12)">
                <g data-part="depth" opacity="0.87">
                  <g transform="matrix(1 0 0 2.71 0 -20.52)" strokeWidth="1.45">
                    <path d="M18.15 10.55 19.6 9.15 21.05 10.55" />
                    <path d="M18.85 11.05V12.2" />
                    <path d="M20.35 11.05V12.2" />
                    <path d="M18.05 12.55H21.15" />
                  </g>
                </g>
              </g>
            </g>
          </g>
          <g transform="rotate(240 12 12)">
            <g data-part="mark">
              <g transform="rotate(-240 19.6 12)">
                <g data-part="depth" opacity="0.57">
                  <g transform="matrix(1 0 0 2.71 0 -20.52)" strokeWidth="1.45">
                    <path d="M18.15 10.55 19.6 9.15 21.05 10.55" />
                    <path d="M18.85 11.05V12.2" />
                    <path d="M20.35 11.05V12.2" />
                    <path d="M18.05 12.55H21.15" />
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>
    </g>
  ),

  /**
   * Income and expenses: one wallet, two directions.
   *
   * The pair has to read as a pair and still never be mistaken for one another, so the
   * wallet is the same object in both — same body, same card slot, drawn at the same place —
   * and everything that distinguishes them is the money and the way it goes. The wallet
   * itself never moves in either: it is the thing money happens to.
   *
   * The note is there at rest, and it is there on opposite sides: coming down on the left for
   * income, going up on the right for expenses, each leaning the way it travels. That is
   * deliberate and it is the whole difference — the two sat in the same sidebar drawn as the
   * same wallet, and a pair you can only tell apart by hovering is one icon used twice.
   *
   * Hovering completes the movement rather than starting it. The note carries on the way it
   * was already leaning, fades through the rim — which is how a stroked drawing says "behind"
   * without a fill to hide anything under — and the next one takes its place from where the
   * first came. The card slot flexes as it passes: the wallet answering with one of its
   * parts, not the picture nodding.
   *
   * The chevron is the only part that is not a thing. It is the direction, and it sits on the
   * side the money is going.
   */
  income: (
    <g>
      <rect data-part="body" x="3.2" y="9.6" width="17.6" height="10.8" rx="2.6" />
      <path data-part="clasp" d="M20.8 13.4h-3.7a1.7 1.7 0 0 0 0 3.4h3.7" />
      {/* the note, leaning in from the left, already on its way down */}
      <g data-part="cash">
        <g transform="rotate(-13 10 7.2)">
          <rect x="5.4" y="4.9" width="7.4" height="4.6" rx="0.7" />
          <path d="M8.4 7.2h1.4" />
        </g>
      </g>
      {/* in */}
      <g data-part="cue" opacity="0.55">
        <path d="M18.4 3.9v3.4" />
        <path d="M17.1 6 18.4 7.3 19.7 6" />
      </g>
    </g>
  ),

  expenses: (
    <g>
      <rect data-part="body" x="3.2" y="9.6" width="17.6" height="10.8" rx="2.6" />
      <path data-part="clasp" d="M20.8 13.4h-3.7a1.7 1.7 0 0 0 0 3.4h3.7" />
      {/* the same note on the other side, leaning out and already on its way up */}
      <g data-part="cash">
        <g transform="rotate(13 14 7.2)">
          <rect x="11.2" y="4.9" width="7.4" height="4.6" rx="0.7" />
          <path d="M14.2 7.2h1.4" />
        </g>
      </g>
      {/* out */}
      <g data-part="cue" opacity="0.55">
        <path d="M5.6 7.3V3.9" />
        <path d="M4.3 5.2 5.6 3.9 6.9 5.2" />
      </g>
    </g>
  ),

  /* a house: the roof lifts off its walls, the walls step apart, all of it returns */
  /**
   * The house, with a car pulling up in front of it.
   *
   * The house is the one that was already there, lifted and narrowed so a car has road to
   * arrive on. The car is drawn the way a car actually reads at this size: a bonnet line
   * rising into a cabin, a roof shorter than the body, and two wheels sitting under the
   * overhangs rather than at the corners. Anything more detailed turns to mud at seventeen
   * pixels; anything less is a box.
   */
  /**
   * The house, with a car pulling up in front of it.
   *
   * Two lessons from getting this wrong. A wheel has to be big enough that its own stroke
   * does not fill it in — below about a 1.4 radius at this weight it renders as a dot, which
   * is what made the first attempt look like a monster truck. And the car needs fewer lines,
   * not more: a sill, a bonnet rising into a cabin, and two wheels. Pillars and a road turned
   * to mud the moment the icon was drawn at the size it is actually used.
   */
  /**
   * The house, with a car pulling up in front of it.
   *
   * Proportion is the whole difficulty. A car reads as a car when the body is long and low
   * and the wheels are small enough to tuck into it — roughly a sixth of the body's length.
   * Wheels any larger, or a cabin any taller, and the shape stops being a car and becomes
   * two circles under a hump, which is what the first two attempts were.
   *
   * The car sits lower than the house because it is in front of it. Nothing else says that.
   */
  /**
   * The house, with a car pulling up in front of it.
   *
   * The car is filled rather than stroked, and that is the whole trick. Every other icon here
   * is an outline at a 1.75 stroke, and at that weight a wheel small enough to belong on a
   * car this size has a stroke wider than its own diameter — it can only ever render as a
   * dot. Twice I drew it stroked and twice it came out a smudge.
   *
   * A solid shape has no such floor, and it says something the outline could not: the car is
   * nearer than the house. Which is also why it sits lower.
   */
  /**
   * And both of them drawn at the size the rest of the set is drawn at.
   *
   * Two objects in one frame will always be smaller than one, but they were smaller than they
   * needed to be: the house held the top-right quadrant and the car the bottom-left, and each
   * read as about half the subject every other icon here draws. Beside a full-width house on
   * the properties mark or a full-width chart on the statistics one, the same weight of line
   * around a smaller shape reads as finer, not as further away.
   *
   * Each grows into the empty corner beside it rather than about the middle — the house
   * anchored at its bottom-right, the car at its bottom-left — so the two keep their places
   * and their overlap deepens, which is the one thing the composition was always saying: the
   * car is in front. The house's stroke is divided by its own scale so the line comes out at
   * the set's weight rather than a fifth heavier; the car is filled and needs no such care.
   */
  assets: (
    <g>
      <g transform="translate(20.8 15) scale(1.2) translate(-20.8 -15)" strokeWidth="1.46">
        <path data-part="roof" d="M10 9 15.4 4.4l5.4 4.6" />
        <path data-part="wallL" d="M11.6 8.4v7" />
        <path data-part="wallR" d="M19.2 8.4v7" />
        <path data-part="floor" d="M10.7 15.4h9.4" />
        <path data-part="door" d="M14.2 15.4v-3.3h2.6v3.3" />
      </g>
      <g transform="translate(1.5 21.2) scale(1.25) translate(-1.5 -21.2)">
        <g data-part="car" fill="currentColor" stroke="none">
          <path d="M1.5 19.1v-1.7c0-.3.2-.5.4-.6l1.8-.4 1.4-1.5c.2-.2.4-.3.7-.3h2.6c.3 0 .5.1.7.3l1.3 1.5 1.8.4c.3.1.4.3.4.6v1.7c0 .3-.2.5-.5.5H2c-.3 0-.5-.2-.5-.5z" />
          <circle cx="4" cy="19.9" r="1.25" />
          <circle cx="9.4" cy="19.9" r="1.25" />
        </g>
      </g>
    </g>
  ),

  /* three bars stacked in a pyramid, seen from above and to the left */
  /**
   * Three bars in a pyramid, drawn in perspective.
   *
   * They used to sit almost edge to edge, which at seventeen pixels reads as one dense
   * shape rather than three objects. Each bar is a little shorter now and there is real
   * space between them at rest, so the stack is legible before anything moves; hovering
   * opens that space further rather than creating it.
   */
  gold: (
    <g>
      <g data-part="barTop">
        <path d="M10.3 6.6h5.4l-2.2 2.2v2.3H8.1V8.8z" />
        <path d="M7.9 8.8h5.4l2.2-2.2" />
      </g>
      <g data-part="barLeft">
        <path d="M5.4 12.4h5.4l-2.2 2.2v2.6H3.2v-2.6z" />
        <path d="M3 14.6h5.4l2.2-2.2" />
      </g>
      <g data-part="barRight">
        <path d="M15.4 12.4h5.4l-2.2 2.2v2.6h-5.4v-2.6z" />
        <path d="M13 14.6h5.4l2.2-2.2" />
      </g>
      <g data-part="glint" opacity="0">
        <path d="M21.2 4.4v2.6M20 5.7h2.6" />
        <path d="M3.4 6.6v1.8M2.5 7.5h1.8" />
      </g>
    </g>
  ),

  /* a trace that steps upward, each leg rising in turn */
  stocks: (
    <g>
      <path d="M3.4 20.4h17.2" />
      <path data-part="s1" d="M4.6 16.4 8.4 12.6" />
      <path data-part="s2" d="M8.4 12.6l3.6 2.6" />
      <path data-part="s3" d="M12 15.2 15.8 9" />
      <path data-part="s4" d="M15.8 9 19.4 5.4" />
      <path data-part="head" d="M16.6 5.4h2.8v2.8" />
    </g>
  ),

  /* a balance whose beam tips and whose pans stay level under it */
  zakat: (
    <g>
      <path d="M12 4.4v15.2" />
      <path d="M8 20.4h8" />
      <g data-part="beam">
        <path d="M4.6 7.6h14.8" />
        <path data-part="chainL" d="M6.6 7.6v1.6" />
        <path data-part="chainR" d="M17.4 7.6v1.6" />
      </g>
      <g data-part="panL"><path d="M3.4 9.2h6.4l-3.2 4.4z" /></g>
      <g data-part="panR"><path d="M14.2 9.2h6.4l-3.2 4.4z" /></g>
      <circle cx="12" cy="4.4" r="1.2" />
    </g>
  ),

  /* two lanes running opposite ways — value going out and value coming back */
  /**
   * Money moving: a coin leaving one account and landing in another.
   *
   * Two shallow dishes at the same low camera as the pie, each with the side of itself
   * underneath, and a coin sitting in the left one. Hovering throws the coin over: it rises,
   * crosses, drops into the right dish and settles, and the dish it lands in takes the
   * weight for a moment. Then it is back on the left, having faded out and in across the
   * gap, so the loop has no jump in it.
   *
   * The arc is two transforms stacked — the horizontal carry on the outer group, the rise
   * and fall on the inner — because a single translate can only move in a straight line and
   * a thrown coin does not.
   */
  /**
   * Money moving: a coin leaving one pile and landing on another.
   *
   * Two stacks at the same low camera as the pie — three deep on the left, one on the right,
   * because a movement needs somewhere it is leaving from and somewhere that is short of it.
   * Hovering lifts the top coin off the left stack, throws it across and drops it onto the
   * right one, which gives under the weight as it arrives. Then it is back where it began,
   * faded out and in across the gap so the loop closes without the coin sliding home.
   *
   * The arc is two animations on nested groups — the carry across on the outer, the rise and
   * fall on the inner — because one translate can only travel in a straight line and a coin
   * thrown between two hands does not.
   */
  /**
   * Money moving: a coin leaving one pile and landing on another.
   *
   * Two stacks at the same low camera as the pie — three coins on the left, one on the
   * right — because a movement wants somewhere it is leaving and somewhere that is short.
   * Only the top coin of a stack shows its face; the ones under it show the edge and
   * nothing else, which is what a stack of coins actually presents to the eye.
   *
   * Hovering lifts the top coin off the left stack, throws it across and sets it down on the
   * right one, which gives under the weight as it arrives. Then it is back where it began,
   * faded out and in over the gap, so the loop closes without the coin sliding home.
   *
   * The throw is two animations on nested groups — the carry across on the outer, the rise
   * and fall on the inner — because one translate can only travel in a straight line and a
   * coin thrown between two hands does not.
   */
  /**
   * Money flow: what came in, what it pooled in, and what left — three stages, and coins
   * crossing between them without stopping.
   *
   * The three columns of the screen's own chart, built in the same isometric world as the
   * pie: a stack on the left where money arrives, a wide shallow pool in the middle that is
   * the account it sits in, and a stack on the right for what actually went out. All three
   * share one baseline, so the pool reads as broad rather than sunk, and only the top coin
   * of a stack shows its face — the ones under it show the edge, which is what a stack of
   * coins presents to the eye.
   *
   * Two coins are in the air at once, half a cycle apart: one leaving the stack for the
   * pool, one leaving the pool for the far stack. That offset is the whole point — with one
   * coin the icon shows a payment, with two overlapping it shows a flow, and the thing that
   * receives each coin gives under it as it lands.
   *
   * Each throw is two animations on nested groups, the carry across on the outer and the
   * rise and fall on the inner, because one translate can only travel in a straight line and
   * a thrown coin does not. Both reset under the fade, so neither coin is ever seen sliding
   * back across the gap it has just crossed.
   */
  flow: (
    <g strokeWidth="1.3">
      <path d="M1.4 17.4A2.9 1.25 0 0 0 7.2 17.4L7.2 19A2.9 1.25 0 0 1 1.4 19Z"
            stroke="none" fill="currentColor" fillOpacity="0.28" />
      <path d="M1.4 17.4A2.9 1.25 0 0 0 7.2 17.4" />
      <path d="M1.4 15.8A2.9 1.25 0 0 0 7.2 15.8L7.2 17.4A2.9 1.25 0 0 1 1.4 17.4Z"
            stroke="none" fill="currentColor" fillOpacity="0.32" />
      <path d="M1.4 15.8A2.9 1.25 0 0 0 7.2 15.8" />
      <path d="M1.4 14.2A2.9 1.25 0 0 0 7.2 14.2L7.2 15.8A2.9 1.25 0 0 1 1.4 15.8Z"
            stroke="none" fill="currentColor" fillOpacity="0.36" />
      <path d="M1.4 14.2A2.9 1.25 0 0 0 7.2 14.2" />
      <g data-part="pool">
        <path d="M7.8 17A4.2 1.8 0 0 0 16.2 17L16.2 19A4.2 1.8 0 0 1 7.8 19Z"
              stroke="none" fill="currentColor" fillOpacity="0.34" />
        <ellipse cx="12" cy="17" rx="4.2" ry="1.8" fill="currentColor" fillOpacity="0.12" />
      </g>
      <g data-part="far">
        <path d="M16.8 17.4A2.9 1.25 0 0 0 22.6 17.4L22.6 19A2.9 1.25 0 0 1 16.8 19Z"
              stroke="none" fill="currentColor" fillOpacity="0.3" />
        <path d="M16.8 17.4A2.9 1.25 0 0 0 22.6 17.4" />
        <path d="M16.8 15.8A2.9 1.25 0 0 0 22.6 15.8L22.6 17.4A2.9 1.25 0 0 1 16.8 17.4Z"
              stroke="none" fill="currentColor" fillOpacity="0.34" />
        <ellipse cx="19.7" cy="15.8" rx="2.9" ry="1.25" fill="currentColor" fillOpacity="0.12" />
      </g>
      <ellipse data-part="uncover" cx="4.3" cy="14.2" rx="2.9" ry="1.25"
               fill="currentColor" fillOpacity="0.18" opacity="0" />
      <g data-part="carryA">
        <g data-part="liftA">
          <path d="M1.4 12.6A2.9 1.25 0 0 0 7.2 12.6L7.2 14.2A2.9 1.25 0 0 1 1.4 14.2Z"
                stroke="none" fill="currentColor" fillOpacity="0.52" />
          <ellipse cx="4.3" cy="12.6" rx="2.9" ry="1.25" fill="currentColor" fillOpacity="0.26" />
        </g>
      </g>
      {/* the coin the far stack gains, and the face the leaving coin uncovers: both are
          nothing at rest and appear only while a coin is away from home */}
      <g data-part="gain" opacity="0">
        <path d="M16.8 14.2A2.9 1.25 0 0 0 22.6 14.2L22.6 15.8A2.9 1.25 0 0 1 16.8 15.8Z"
              stroke="none" fill="currentColor" fillOpacity="0.34" />
        <ellipse cx="19.7" cy="14.2" rx="2.9" ry="1.25" fill="currentColor" fillOpacity="0.12" />
      </g>
      <g data-part="carryB" opacity="0">
        <g data-part="liftB">
          <path d="M9.1 15.2A2.9 1.25 0 0 0 14.9 15.2L14.9 16.8A2.9 1.25 0 0 1 9.1 16.8Z"
                stroke="none" fill="currentColor" fillOpacity="0.52" />
          <ellipse cx="12" cy="15.2" rx="2.9" ry="1.25" fill="currentColor" fillOpacity="0.26" />
        </g>
      </g>
    </g>
  ),

  /* three sliders whose handles travel along their tracks */
  settings: (
    <g>
      <path d="M3.4 7h17.2M3.4 12h17.2M3.4 17h17.2" />
      <circle data-part="k1" cx="8" cy="7" r="2.1" />
      <circle data-part="k2" cx="15" cy="12" r="2.1" />
      <circle data-part="k3" cx="10" cy="17" r="2.1" />
    </g>
  ),
  /**
   * A property.
   *
   * The asset class, not the screen: `assets` is everything owned and draws a car at the
   * house to say so, and this is the house alone — what a flat under an installment plan is
   * marked as, wherever one appears. The roof lifts off the walls and the walls step out from
   * under it; the floor stays, because the floor is the ground.
   */
  realestate: (
    <g>
      <path data-part="roof" d="M2.9 11.4 12 4.2l9.1 7.2" />
      <path data-part="wallL" d="M5.6 10.6V20.2" />
      <path data-part="wallR" d="M18.4 10.6V20.2" />
      <path data-part="floor" d="M4.2 20.2h15.6" />
      <path data-part="door" d="M9.9 20.2v-4.8h4.2v4.8" />
    </g>
  ),

  /**
   * Budgets: a ceiling, and how near the spending is to it.
   *
   * A budget is not a period and not a category — it is a limit, and what a limit needs is
   * something running at it. The track and the line at the end of it are the fixed facts; the
   * band inside is the only part that is actually a number, so it is the only part that
   * moves. It grows from its own left edge rather than from the middle, and the limit answers
   * with light as the band closes on it, because a limit that moved would not be one.
   *
   * Drawn along rather than up. Standing it on end made a lidded column, which at seventeen
   * pixels is a bin, and there is already a bin in this set.
   */
  budgets: (
    <g>
      {/* the allowance, and the limit standing at the end of it */}
      <rect x="2.9" y="9.2" width="18.2" height="5.6" rx="2.8" />
      <rect data-part="fill" x="4.3" y="10.6" width="6.4" height="2.8" rx="1.4"
            stroke="none" fill="currentColor" fillOpacity="0.34" />
      <path data-part="limit" d="M17.6 6.4v11.2" />
      <path data-part="limitCap" d="M16.5 6.4h2.2M16.5 17.6h2.2" opacity="0.5" />
    </g>
  ),

  /**
   * Logs: everything the ledger was asked to write, newest at the top.
   *
   * A clock stood here before, and a clock is a time, not a record — the screen is a list of
   * entries, so the mark is a list of entries. The rail is the thing they are all hung on and
   * it never moves; each entry's mark appears and its line writes itself out to the right, in
   * the order they were made.
   */
  logs: (
    <g>
      <path d="M5.6 4.9v14.4" />
      <g data-part="e1"><circle cx="5.6" cy="7.4" r="1.45" /><path d="M9.2 7.4h9.2" /></g>
      <g data-part="e2"><circle cx="5.6" cy="12" r="1.45" /><path d="M9.2 12h7" /></g>
      <g data-part="e3"><circle cx="5.6" cy="16.6" r="1.45" /><path d="M9.2 16.6h8.4" /></g>
    </g>
  ),

  /**
   * Debts: a signed note, and the money against it.
   *
   * Lent or borrowed, a debt is a promise written down — which is a different thing from the
   * handshake that used to stand here, and the handshake means agreement, which the money
   * flow also needs. Both halves are there at rest — a slip with money against it is the
   * mark, and a mark that is only legible while a cursor is on it is not a mark. The slip
   * never moves: it is the undertaking. The signature writes itself and the coin presses up
   * against the corner, which is the other half, the paying.
   */
  debts: (
    <g>
      <rect data-part="slip" x="3.2" y="5.8" width="15.6" height="11.4" rx="2" />
      <path d="M6.4 9.4h6.8" opacity="0.5" />
      <path data-part="sig" d="M6.4 13.6c1.4-2 2.5-2 3.3 0 .8 2 1.9 2 3.3 0" />
      <g data-part="coin">
        <circle cx="18.4" cy="17.4" r="3.1" />
        <path d="M18.4 15.8v3.2" />
      </g>
    </g>
  ),

  /**
   * Charity: the heart, and what is put into it.
   *
   * The heart is this application's mark for giving and for nothing else — not health, not a
   * favourite, not a thing you liked. It is drawn once, here, and it holds still: what moves
   * is the coin that falls into the notch at the top of it, and the answering shape inside
   * that comes up as the coin arrives. That is the whole sentence — something given, and
   * something that registers it.
   */
  charity: (
    <g>
      <g transform="translate(12 16) scale(0.82) translate(-12 -16)">
        <path data-part="heart" d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        <g data-part="beat" opacity="0" transform="translate(12 14.6) scale(0.52) translate(-12 -14.6)">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"
                stroke="none" fill="currentColor" fillOpacity="0.24" />
        </g>
      </g>
      <g data-part="coin" opacity="0">
        <circle cx="12" cy="7.2" r="2.2" />
        <path d="M12 5.9v2.6" />
      </g>
    </g>
  ),

  /**
   * Sadaqat: cupped hands, and the coin leaving them.
   *
   * Giving that is chosen rather than owed. It shared a heart with charity before, which made
   * two different obligations look like the same one — so this one keeps the hands and
   * charity keeps the heart, and neither borrows the other's.
   *
   * The fingers are not decoration. Cupped hands drawn as one arc with a coin sitting in them
   * is an eye with a pupil, which is what the first attempt was; four fingers coming up out
   * of the rim, and the coin held clear above them, is a hand offering something. The hands
   * stay put — the coin rises out and goes, and the cup gives a little as it lets go.
   */
  hands: (
    <g>
      <path data-part="cup" d="M4.2 14.4a7.8 4.6 0 0 0 15.6 0" />
      <path data-part="fingers" d="M4.2 14.4 5.5 11.1M8.4 13.6 9 10.2M15.6 13.6 15 10.2M19.8 14.4 18.5 11.1" />
      <g data-part="coin">
        <circle cx="12" cy="6.4" r="2.8" />
        <path d="M12 4.8v3.2" />
      </g>
    </g>
  ),
};

export const ANIM_NAMES = Object.keys(SCENES) as AnimName[];
