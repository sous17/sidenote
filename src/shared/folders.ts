// Windows are per folder: a window's path names the folder its sessions run in.

/** A session's folder by name, the last segment of its cwd; "" when the cwd is unknown. */
export function folderName(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() ?? "";
}

/** The page path of a folder's window; "/" when there is no folder to name. */
export function folderPath(folder: string): string {
  return folder ? `/${encodeURIComponent(folder)}` : "/";
}

/** The folder a page path names, or "" for "/" and anything that isn't a single segment. */
export function folderFromPath(pathname: string): string {
  const match = /^\/([^/]+)$/.exec(pathname);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return "";
  }
}
