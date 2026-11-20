import { Button } from "../../ui/controls";
import { useEffect, useRef, useState } from "react";
import type { WorkflowFile, WorkflowFilePage } from "../../../shared/workflow-contracts";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { ConfigurationEditorDialog } from "../../components/configuration/configuration-editor-dialog";

/** 从独立常量目录选择已有文件，不复制运行文件或修改当前草稿。 */
export function WorkflowFilePicker({type, onSelect, onClose}: {type: string; onSelect: (file: WorkflowFile) => void; onClose: () => void}) {
  const {runApiTask} = useApiTask();
  const [query,setQuery] = useState(""), [page,setPage] = useState(1), [data,setData] = useState<WorkflowFilePage>();
  const sequence = useRef(0);
  useEffect(() => {
    const ticket = ++sequence.current;
    setData(undefined);
    void runApiTask(() => api.listWorkflowFiles({directory:"constants", q:query, type: type === "file" ? "" : type, page:String(page), pageSize:"20"}), {operation:"读取文件常量目录"}).then((result) => { if (ticket === sequence.current && result.status === "success") setData(result.data); });
    return () => {sequence.current++;};
  },[query,page,type,runApiTask]);
  return <ConfigurationEditorDialog variant="confirmation" title="选择文件常量" description="文件保存在独立常量目录，被工作流引用后禁止删除。" busy={false} onClose={onClose} footer={<><Button type="button" className="configuration-secondary-action" onClick={onClose}>取消</Button><Button type="button" className="configuration-secondary-action" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</Button><Button type="button" className="configuration-secondary-action" disabled={!data || page * 20 >= data.total} onClick={() => setPage(page + 1)}>下一页</Button></>}>
    <div className="wf-fields wf-import-fields"><label className="wf-copy-name">搜索文件名<input aria-label="搜索文件常量" value={query} onChange={(event) => {setQuery(event.target.value);setPage(1);}}/></label>
      {!data ? <p>正在读取文件常量…</p> : !data.files.length ? <p>没有符合条件的常量，可关闭后上传文件。</p> : data.files.map((file) => <Button type="button" className="wf-button" key={file.assetId} onClick={() => onSelect({assetId:file.assetId,name:file.name,mediaType:file.mediaType,size:file.size})}>{file.name}</Button>)}
    </div>
  </ConfigurationEditorDialog>;
}
