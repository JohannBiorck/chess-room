import type { Color } from "@chess-room/contracts";

export function Cat({ color = "white", evil = false }: { color?: Color; evil?: boolean }) {
  return (
    <svg
      className={`cat-illustration cat-illustration--${color}${evil ? " cat-illustration--evil" : ""}`}
      viewBox="0 0 120 100"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse className="cat-shadow" cx="61" cy="87" rx="43" ry="6" />
      <path className="cat-tail" d="M34 69C13 74 9 54 17 43c7-10 1-19-5-14" />
      <path
        className="cat-fur"
        d="M27 65c0-18 14-29 32-25 13 2 23 11 24 29l-9 13H41c-9-1-14-6-14-17Z"
      />
      <path className="cat-patch" d="M38 51c-7 8-6 21 4 26h14c-13-8-9-17-18-26Z" />
      <path className="cat-fur" d="M36 65c8-4 15 3 13 14l-2 7H28c-3-5 2-8 8-8V65Z" />
      <path className="cat-stripe" d="m39 48 6 6m3-11 5 7m-23 4 6 4" />
      <path
        className="cat-fur"
        d="m64 22-2-17 19 11L98 5l1 21c7 8 6 22-2 29-9 9-26 9-35 0-10-9-9-24 2-33Z"
      />
      <path className="cat-ear" d="m67 11 2 12 7-5Zm26 1-9 7 10 5Z" />
      <path className="cat-patch" d="M64 43c8-3 11-1 17 2 8-5 13-5 19-1-4 16-29 20-36-1Z" />
      <path className="cat-stripe" d="m78 16 2 8m8-8-3 8" />
      <ellipse className="cat-eye" cx="72" cy="34" rx="3" ry="4" />
      <ellipse className="cat-eye" cx="91" cy="34" rx="3" ry="4" />
      <circle className="cat-eye-glint" cx="73" cy="32.5" r="1" />
      <circle className="cat-eye-glint" cx="92" cy="32.5" r="1" />
      {evil && <path className="cat-brow" d="m68 28 8 3m11 0 8-3" />}
      <path className="cat-nose" d="m77 42 8 0-4 5Z" />
      <path
        className="cat-face-line"
        d="M81 47v3m0 0c-3 4-7 3-9 1m9-1c3 4 7 3 9 1M61 43l-12-3m13 8-13 2m50-7 12-3m-13 8 13 2"
      />
      <path className="cat-collar" d="M63 59c12 8 26 7 37-2" />
      <circle className="cat-bell" cx="87" cy="65" r="4" />
      <g className="cat-front-paw">
        <path
          className="cat-fur"
          d="M72 62c8-5 15 0 14 8l-1 13c9 0 10 6 7 8H75c-5-3-4-8-3-12V62Z"
        />
        <path className="cat-face-line" d="M79 88v3m6-3v3" />
      </g>
    </svg>
  );
}
