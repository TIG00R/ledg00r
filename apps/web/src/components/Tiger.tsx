/**
 * Ledg00r.
 *
 * A young tiger in spectacles who lives on the assistant screen. He is drawn rather than
 * animated frame by frame, so every mood is the same character with different parts moved —
 * which is what makes him read as one creature rather than a set of pictures.
 *
 * The moods are the states the assistant actually has: waiting, thinking, looking something
 * up, saying something, and having got it wrong. Nothing decorative that does not mean one
 * of those.
 */
export type Mood = 'idle' | 'thinking' | 'searching' | 'talking' | 'pleased' | 'sorry';

export function Tiger({ mood = 'idle', size = 160 }: { mood?: Mood; size?: number }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={`tiger tiger-${mood}`}
         role="img" aria-label={`Ledg00r, ${mood}`}>
      <defs>
        <linearGradient id="fur" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#E8964A" />
          <stop offset="100%" stopColor="#D2762C" />
        </linearGradient>
        <linearGradient id="belly" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FBEBD7" />
          <stop offset="100%" stopColor="#F2D9BC" />
        </linearGradient>
      </defs>

      {/* the tail keeps its own time, because a tail always does */}
      <g className="t-tail">
        <path d="M84 92c14 2 20-6 18-16" fill="none" stroke="url(#fur)" strokeWidth="7"
              strokeLinecap="round" />
        <path d="M96 79c4 1 6-2 6-5" fill="none" stroke="#3A2A1C" strokeWidth="4"
              strokeLinecap="round" />
      </g>

      <g className="t-body">
        {/* legs */}
        <rect className="t-legL" x="42" y="86" width="12" height="18" rx="6" fill="url(#fur)" />
        <rect className="t-legR" x="66" y="86" width="12" height="18" rx="6" fill="url(#fur)" />

        {/* torso */}
        <rect x="36" y="60" width="48" height="36" rx="17" fill="url(#fur)" />
        <ellipse cx="60" cy="80" rx="14" ry="15" fill="url(#belly)" />
        <path d="M40 68h8M40 78h7M80 68h-8M80 78h-7" stroke="#3A2A1C" strokeWidth="3"
              strokeLinecap="round" />

        {/* arms — one of them points while he talks */}
        <rect className="t-armL" x="26" y="64" width="11" height="24" rx="5.5" fill="url(#fur)" />
        <rect className="t-armR" x="83" y="64" width="11" height="24" rx="5.5" fill="url(#fur)" />
      </g>

      <g className="t-head">
        {/* ears */}
        <circle className="t-earL" cx="38" cy="26" r="10" fill="url(#fur)" />
        <circle className="t-earR" cx="82" cy="26" r="10" fill="url(#fur)" />
        <circle cx="38" cy="26" r="4.5" fill="#C4614F" />
        <circle cx="82" cy="26" r="4.5" fill="#C4614F" />

        {/* head */}
        <rect x="27" y="18" width="66" height="52" rx="25" fill="url(#fur)" />
        <path d="M60 20v10M45 24l3 8M75 24l-3 8" stroke="#3A2A1C" strokeWidth="3.4"
              strokeLinecap="round" />
        <ellipse cx="60" cy="52" rx="19" ry="15" fill="url(#belly)" />

        {/* eyes behind the spectacles */}
        <g className="t-eyes">
          <circle className="t-eye" cx="50" cy="43" r="4.6" fill="#2B2018" />
          <circle className="t-eye" cx="70" cy="43" r="4.6" fill="#2B2018" />
          <circle cx="51.6" cy="41.4" r="1.5" fill="#fff" />
          <circle cx="71.6" cy="41.4" r="1.5" fill="#fff" />
        </g>

        {/* the spectacles he is forever pushing back up */}
        <g className="t-specs">
          <circle cx="50" cy="43" r="10" fill="none" stroke="#2B2018" strokeWidth="2.6" />
          <circle cx="70" cy="43" r="10" fill="none" stroke="#2B2018" strokeWidth="2.6" />
          <path d="M60 43h0M40 41l-8-3M80 41l8-3" stroke="#2B2018" strokeWidth="2.6"
                strokeLinecap="round" />
          <path d="M60 43a4 4 0 0 1 0 0" stroke="#2B2018" strokeWidth="2.6" />
          <path d="M54.2 43h11.6" stroke="#2B2018" strokeWidth="2.6" strokeLinecap="round" />
          <path className="t-glint" d="M45 38l4-3" stroke="#fff" strokeWidth="2.4"
                strokeLinecap="round" opacity="0" />
        </g>

        {/* muzzle */}
        <path d="M56 55h8l-4 4z" fill="#2B2018" />
        <path className="t-mouth" d="M54 61q6 5 12 0" fill="none" stroke="#2B2018"
              strokeWidth="2.6" strokeLinecap="round" />
        <path d="M40 56h9M80 56h-9M40 61h8M80 61h-8" stroke="#3A2A1C" strokeWidth="2"
              strokeLinecap="round" opacity="0.6" />
      </g>

      {/* what he is doing, when he is doing something */}
      <g className="t-thought">
        <circle cx="96" cy="30" r="3" fill="currentColor" opacity="0.5" />
        <circle cx="104" cy="21" r="4.5" fill="currentColor" opacity="0.5" />
        <circle className="t-dot t-dot1" cx="99" cy="10" r="2.6" fill="currentColor" />
        <circle className="t-dot t-dot2" cx="107" cy="10" r="2.6" fill="currentColor" />
        <circle className="t-dot t-dot3" cx="115" cy="10" r="2.6" fill="currentColor" />
      </g>

      <g className="t-lens">
        <circle cx="103" cy="20" r="9" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d="M110 27l7 7" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" />
      </g>
    </svg>
  );
}
