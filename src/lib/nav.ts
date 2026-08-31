export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/workspace") {
    return pathname === "/workspace" || pathname.startsWith("/workspace/");
  }
  if (href === "/workspace-v2") {
    return (
      pathname === "/workspace-v2" || pathname.startsWith("/workspace-v2/")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}
