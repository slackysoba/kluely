import { ImageResponse } from "next/og";

// Social preview card, generated at build time from the logo's path data
// (kept in sync with components/Logo.tsx). Pure SVG — no font loading, so
// the render is fully static and deterministic.

export const alt = "Kluely — interview coaching for Klingons";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#ededef";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 56,
          background: "#0a0a0b",
        }}
      >
        <svg width={870} height={154} viewBox="0 0 316 56" fill="none">
          {/* Profile mark */}
          <path
            fill={INK}
            d="M21 54 C18 50 17 47 17 44 L8 48 C5 42 4 36 6 30 L1 26 C4 20 8 13 14 9 C16 7 19 6 22 6 L24 8 L27 4 L30 9 L33 6 L36 11 L38 16 L37 20 L42 25 L38 28 L45 33 L38 37 L40 40 L36 42 L39 45 L34 47 L36 53 L28 50 Z"
          />
          {/* Wordmark */}
          <g transform="translate(-10 0)">
            <g stroke={INK} strokeWidth="6" fill="none">
              <path d="M75 10 V46" />
              <path d="M94 12 L78 28 L94 44" />
              <path d="M115 10 V43 H136" />
              <path d="M159 10 V43 H179 V10" />
              <path d="M218 13 H199 V43 H218" />
              <path d="M199 27 H212" />
              <path d="M243 10 V43 H264" />
              <path d="M287 10 L300 27 L313 10" />
              <path d="M300 27 V46" />
            </g>
            <g fill={INK}>
              <path d="M96.1 14.1 L91.9 9.9 L100.4 5.6 Z" />
              <path d="M136 40 L136 46 L145 43 Z" />
              <path d="M264 40 L264 46 L273 43 Z" />
              <path d="M218 10 L218 16 L226 13 Z" />
              <path d="M218 40 L218 46 L226 43 Z" />
              <path d="M289.4 8.2 L284.6 11.8 L281.5 2.9 Z" />
              <path d="M310.6 11.8 L315.4 8.2 L318.5 2.9 Z" />
            </g>
          </g>
        </svg>
        {/* Single accent element — brand red underline */}
        <div
          style={{
            width: 72,
            height: 5,
            borderRadius: 3,
            background: "#d6323c",
            display: "flex",
          }}
        />
      </div>
    ),
    { ...size }
  );
}
