import { Button } from "../../ui/controls";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConfigurationEditorDialog } from "../../components/configuration/configuration-editor-dialog";
import "../../configuration-dialog.css";
const Context = createContext<(message: string) => Promise<boolean>>(
  async () => false,
);
/** 工作流的删除和未保存确认复用应用弹层，保持键盘焦点与主题一致。 */
export function WorkflowConfirmProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string>();
  const pending = useRef<((answer: boolean) => void) | undefined>(undefined);
  useEffect(() => () => pending.current?.(false), []);
  const finish = (answer: boolean) => {
    pending.current?.(answer);
    pending.current = undefined;
    setMessage(undefined);
  };
  return (
    <Context.Provider
      value={(text) =>
        new Promise((resolve) => {
          pending.current?.(false);
          pending.current = resolve;
          setMessage(text);
        })
      }
    >
      {children}
      {message && (
        <ConfigurationEditorDialog
          variant="confirmation"
          title="确认工作流操作"
          description={message}
          busy={false}
          onClose={() => finish(false)}
          footer={
            <>
              <Button
                className="configuration-secondary-action"
                onClick={() => finish(false)}
              >
                取消
              </Button>
              <Button variant="primary"
                className="configuration-primary-action"
                onClick={() => finish(true)}
              >
                确定
              </Button>
            </>
          }
        >
          {null}
        </ConfigurationEditorDialog>
      )}
    </Context.Provider>
  );
}
export function useWorkflowConfirm() {
  return useContext(Context);
}
