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
  | 'portfolio' | 'accounts' | 'income' | 'expenses' | 'realestate'
  | 'gold' | 'stocks' | 'zakat' | 'settings' | 'flow' | 'assets'
  | 'dashboards';

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
      {/* the far wedge shows no rim: its own top face stands in front of it */}
      <g data-part="s4">
        <path d="M12 11.4 4.39 8.63A8.4 6.55 0 0 1 12 4.85Z" fill="currentColor" fillOpacity="0.05" />
      </g>
      <g data-part="s1">
        <path d="M20.4 11.4A8.4 6.55 0 0 1 17.94 16.03L17.94 18.33A8.4 6.55 0 0 0 20.4 13.7Z"
              stroke="none" fill="currentColor" fillOpacity="0.38" />
        <path d="M12 11.4 12 4.85A8.4 6.55 0 0 1 17.94 16.03Z" fill="currentColor" fillOpacity="0.17" />
      </g>
      <g data-part="s3">
        <path d="M6.6 16.42A8.4 6.55 0 0 1 3.6 11.4L3.6 13.7A8.4 6.55 0 0 0 6.6 18.72Z"
              stroke="none" fill="currentColor" fillOpacity="0.42" />
        <path d="M12 11.4 6.6 16.42A8.4 6.55 0 0 1 4.39 8.63Z" fill="currentColor" fillOpacity="0.27" />
      </g>
      <g data-part="s2">
        <path d="M17.94 16.03A8.4 6.55 0 0 1 6.6 16.42L6.6 18.72A8.4 6.55 0 0 0 17.94 18.33Z"
              stroke="none" fill="currentColor" fillOpacity="0.32" />
        <path d="M12 11.4 17.94 16.03A8.4 6.55 0 0 1 6.6 16.42Z" fill="currentColor" fillOpacity="0.1" />
      </g>
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

  /* a hand reaching a note into the side pocket of a pair of trousers */
  income: (
    <g>
      <path data-part="waist" d="M10 3.2h9.4v2.4H10z" />
      <path data-part="legs" d="M10 5.6 9.4 20.8H13l1.7-8.8 1.7 8.8h3.6l-.6-15.2" />
      <path data-part="slit" d="M11.5 7c-.8 2-.9 4-.4 5.9" />
      <path data-part="slitIn" d="M12.6 7.4c-.7 1.8-.8 3.5-.3 5.1" opacity="0.4" />
      <g data-part="cash">
        <g transform="rotate(-12 5 11.6)">
          <rect x="1.9" y="9.8" width="6.6" height="3.8" rx="0.6" />
          <path d="M4.6 11.7h1.2" />
        </g>
      </g>
    </g>
  ),

  /* the same hand drawing a note back out of it */
  expenses: (
    <g>
      <path data-part="waist" d="M10 3.2h9.4v2.4H10z" />
      <path data-part="legs" d="M10 5.6 9.4 20.8H13l1.7-8.8 1.7 8.8h3.6l-.6-15.2" />
      <path data-part="slit" d="M11.5 7c-.8 2-.9 4-.4 5.9" />
      <path data-part="slitIn" d="M12.6 7.4c-.7 1.8-.8 3.5-.3 5.1" opacity="0.4" />
      <g data-part="cash">
        <g transform="rotate(-12 5 11.6)">
          <rect x="1.9" y="9.8" width="6.6" height="3.8" rx="0.6" />
          <path d="M4.6 11.7h1.2" />
        </g>
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
  assets: (
    <g>
      <path data-part="roof" d="M10 9 15.4 4.4l5.4 4.6" />
      <path data-part="wallL" d="M11.6 8.4v7" />
      <path data-part="wallR" d="M19.2 8.4v7" />
      <path data-part="floor" d="M10.7 15.4h9.4" />
      <path data-part="door" d="M14.2 15.4v-3.3h2.6v3.3" />
      <g data-part="car" fill="currentColor" stroke="none">
        <path d="M1.5 19.1v-1.7c0-.3.2-.5.4-.6l1.8-.4 1.4-1.5c.2-.2.4-.3.7-.3h2.6c.3 0 .5.1.7.3l1.3 1.5 1.8.4c.3.1.4.3.4.6v1.7c0 .3-.2.5-.5.5H2c-.3 0-.5-.2-.5-.5z" />
        <circle cx="4" cy="19.9" r="1.25" />
        <circle cx="9.4" cy="19.9" r="1.25" />
      </g>
    </g>
  ),

  realestate: (
    <g>
      <path data-part="roof" d="M2.9 11.4 12 4.2l9.1 7.2" />
      <path data-part="wallL" d="M5.6 10.6V20.2" />
      <path data-part="wallR" d="M18.4 10.6V20.2" />
      <path data-part="floor" d="M4.2 20.2h15.6" />
      <path data-part="door" d="M9.9 20.2v-4.8h4.2v4.8" />
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
};

export const ANIM_NAMES = Object.keys(SCENES) as AnimName[];
