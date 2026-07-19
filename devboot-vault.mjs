// Dev rig for the folder-vault worktree — run: node devboot-vault.mjs
// Same rig as devboot-images.mjs, on its own port and data dir so it can run alongside the main
// tree's server without either one stepping on the other.
process.env.PORT = process.env.PORT || "8290";
await import("./devboot-images.mjs");
