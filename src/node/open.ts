// Hands a link or a folder to the desktop, which opens it with its default app: the browser, the
// file manager. Never through a shell.
import { spawn } from "node:child_process";

export function openWithSystem(target: string, onError: () => void): void {
  // On Windows, `cmd /c start` would treat the URL's "&" as a command separator.
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", onError);
  child.unref();
}
