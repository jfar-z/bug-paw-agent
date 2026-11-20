import { useEffect, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../ui/dialog";
import { WorkspaceBrowser, type WorkspaceLocationRequest } from "./workspace-browser";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";

interface QuickWorkspaceDrawerProps {
  open: boolean;
  agentId?: string;
  agentName?: string;
  locationRequest?: WorkspaceLocationRequest;
  message?: string;
  swipeTranslatePercent?: number;
  previewBackRef: RefObject<(() => void) | null>;
  onBack(): void;
  onClose(): void;
}

/** 快捷资源保留跟手过渡，打开后使用公共抽屉管理焦点与键盘。 */
export function QuickWorkspaceDrawer(props: QuickWorkspaceDrawerProps) {
  useEffect(() => {
    if (!props.open) return;
    const onMobileBackRequest = (event: Event) => {
      event.preventDefault();
      props.onBack();
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
  }, [props.open, props.onBack]);

  const swiping = props.swipeTranslatePercent !== undefined;
  if (!props.open && !swiping) return null;
  return createPortal(<Dialog
    drawer="right"
    title="快捷资源管理"
    className="quick-workspace-drawer"
    closeLabel="关闭快捷资源管理"
    headerActions={null}
    interactive={props.open}
    onEscape={props.onBack}
    onClose={props.onClose}
    style={swiping ? { transform: `translateX(${props.swipeTranslatePercent}%)` } : undefined}
  >
    {props.agentName && <p className="quick-workspace-drawer__agent">{props.agentName} 的工作目录</p>}
    {props.message && <p className="configuration-inline-error">{props.message}</p>}
    {props.agentId ? <WorkspaceBrowser
      agentId={props.agentId}
      mode="quick"
      locationRequest={props.locationRequest}
      previewBackRef={props.previewBackRef}
    /> : <p>当前没有可浏览的 Agent 工作目录。</p>}
  </Dialog>, document.body);
}
