interface LogoProps {
  className?: string;
}

/**
 * Kluely wordmark with an original alien warrior hauling himself up over the
 * letters. Drawn in layers: the body sits behind the wordmark (his torso shows
 * through the letter gaps), the letters occlude his arms, and his hands are
 * painted last so they grip the E's crossbar and the L's stem from in front.
 *
 * Monochrome-first: everything is currentColor except the brow, frown, and
 * hair tie, which use the accent red as a highlight and degrade gracefully
 * when the mark is rendered in a single colour.
 */
export default function Logo({ className }: LogoProps) {
  const accent = "var(--accent, #d6323c)";

  return (
    <svg
      viewBox="0 0 326 116"
      role="img"
      aria-label="Kluely"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Kluely</title>

      {/* ---- Character, behind the wordmark ---------------------------- */}
      <g fill="currentColor">
        {/* Torso: visible above the letters and through the E–L gap */}
        <path d="M205 46 C206 38 211 33 217 33 L223 33 C231 33.5 237 39 238 46 C238.5 53 237.5 58 235 62 Q229 66.5 222 66.5 Q212 66.5 207 61 C205.5 56 204.7 51 205 46 Z" />
        {/* Head: three forehead ridges across the crown */}
        <path d="M203 31 C201.5 26 202 19 203.5 15 Q206 6 210.5 9.5 Q211.5 10.2 212.5 9.8 Q216 3.5 219.5 8.5 Q220.5 9.2 221.5 9 Q225.5 5 227 11 C228.5 15 229 24 227.5 29 C225 35.5 220 38 215 38 C210 38 205.5 35.5 203 31 Z" />
        {/* Braid: plaited edge bumps, swinging out to the right */}
        <path d="M225 13 C234 13 242 18 244.5 26 Q246.5 30 244.8 33.5 Q247.3 37 245.2 40.5 Q247.6 44 245.4 47.5 Q247.4 51 244 55 L238.8 55.5 Q238 50 240 47 Q237.4 43.5 239.6 40 Q237.2 36.5 239.4 33 Q237.6 29 239.2 26 C236.5 20.5 231 17.5 225 18.5 Z" />
        {/* Braid tuft below the tie */}
        <path d="M239.5 59 L245 58 L243 66 Q241 63 239.5 59 Z" />
      </g>
      {/* Arms: drop behind the letters toward each handhold */}
      <g
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M208 38 C199 42 193.5 50 192.5 61" />
        <path d="M234 39 C231 40 229 41 228 44" />
      </g>

      {/* ---- Wordmark: KLUELY -------------------------------------------
          Heavy geometric sans built on a 16-unit stroke, cap height 64. */}
      <g stroke="currentColor" strokeWidth="16" fill="none">
        {/* K */}
        <path d="M18 44 V108" />
        <path d="M44 46 L22 77 L44 106" />
        {/* L */}
        <path d="M70 44 V100 H102" />
        {/* U */}
        <path d="M122 44 V100 H152 V44" />
        {/* E */}
        <path d="M204 52 H182 V100 H204" />
        <path d="M182 76 H198" />
        {/* L */}
        <path d="M226 44 V100 H258" />
        {/* Y */}
        <path d="M276 44 L292 70 L308 44" />
        <path d="M292 70 V108" />
      </g>

      {/* ---- Hands, in front of the letters ----------------------------- */}
      <g fill="currentColor">
        {/* Left hand: two knuckles gripping the E's crossbar */}
        <path d="M187 70 Q187 62 192 62 Q194 62 194 65 Q194 61.5 197 61.5 Q201 62 201 70 Z" />
        {/* Right hand: curled over the top of the L's stem */}
        <path d="M220 52 Q219 42 225 42 Q227.5 42 227.5 45 Q227.5 41.5 231 42 Q234 43 233 52 Z" />
      </g>

      {/* ---- Accent highlights: expression and hair tie ------------------ */}
      <g
        stroke={accent}
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      >
        {/* Grumpy brows: inner ends pulled down */}
        <path d="M207.5 19.5 L212.5 22" />
        <path d="M223.5 19.5 L218.5 22" />
        {/* Frown */}
        <path d="M210.5 31 Q215.5 27.5 220.5 31" />
      </g>
      <path
        d="M238 54.5 L245.5 53.5 L246 57 L238.5 58 Z"
        fill={accent}
      />
    </svg>
  );
}
