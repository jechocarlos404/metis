// What each role is called on screen and what it can do. One copy, used by the
// sidebar badge, Users and Settings.
export const ROLE_WORDS = {
  viewer: { label: "Viewer", can: "Reads everything." },
  editor: {
    label: "Editor",
    can: "Reads everything, changes products, features, capabilities, goals and journeys, and imports seed files.",
  },
  admin: {
    label: "Admin",
    can: "Does everything an editor does, and manages users, AI models and raw data.",
  },
};

export const roleLabel = (role) => ROLE_WORDS[role]?.label ?? "No role";
export const roleCan = (role) => ROLE_WORDS[role]?.can ?? "No role yet. Ask an admin of this metis to give you one.";
