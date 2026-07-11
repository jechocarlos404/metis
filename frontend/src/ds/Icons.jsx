// Lucide icons (https://lucide.dev) — paths copied verbatim; 24px grid, stroke 2.
const ICON_PATHS = {
  "message-square": [["path","M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"]],
  target: [["circle","12","12","10"],["circle","12","12","6"],["circle","12","12","2"]],
  network: [["rect","16","16","6","6","1"],["rect","2","16","6","6","1"],["rect","9","2","6","6","1"],["path","M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"],["path","M12 12V8"]],
  package: [["path","M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"],["path","M12 22V12"],["path","m3.3 7 8.7 5 8.7-5"],["path","m7.5 4.27 9 5.15"]],
  settings: [["path","M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"],["circle","12","12","3"]],
  send: [["path","M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"],["path","m21.854 2.147-10.94 10.939"]],
  plus: [["path","M5 12h14"],["path","M12 5v14"]],
  search: [["circle","11","11","8"],["path","m21 21-4.3-4.3"]],
  "chevron-right": [["path","m9 18 6-6-6-6"]],
  "git-branch": [["path","M6 3v12"],["circle","18","6","3"],["circle","6","18","3"],["path","M18 9a9 9 0 0 1-9 9"]],
  sparkles: [["path","M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"]],
  paperclip: [["path","M13.234 20.252 21 12.3"],["path","m16 6-8.414 8.586a2 2 0 0 0 0 2.828 2 2 0 0 0 2.828 0l8.414-8.586a4 4 0 0 0 0-5.656 4 4 0 0 0-5.656 0l-8.415 8.585a6 6 0 1 0 8.486 8.486"]],
  "arrow-right": [["path","M5 12h14"],["path","m12 5 7 7-7 7"]],
  layers: [["path","M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"],["path","m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"],["path","m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"]],
};

function Icon({ name, size = 16, style }) {
  const nodes = ICON_PATHS[name] || [];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none", ...style }}>
      {nodes.map((n, i) => {
        if (n[0] === "path") return <path key={i} d={n[1]} />;
        if (n[0] === "circle") return <circle key={i} cx={n[1]} cy={n[2]} r={n[3]} />;
        if (n[0] === "rect") return <rect key={i} x={n[1]} y={n[2]} width={n[3]} height={n[4]} rx={n[5]} />;
        return null;
      })}
    </svg>
  );
}

export { Icon };
export const ICONS = ICON_PATHS;
