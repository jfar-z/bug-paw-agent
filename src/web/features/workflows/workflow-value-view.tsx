import { SaveMediaResultButton } from "../../components/media-library-actions";
import { useEffect, useState } from "react";
import type { WorkflowFile } from "../../../shared/workflow-contracts";
import { ApiClientError } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { ConfigurationEditorDialog } from "../../components/configuration/configuration-editor-dialog";

/** 只依据受控资产标识识别文件，普通 URL 和文本不会被误判为媒体。 */
function isWorkflowFile(value: unknown): value is WorkflowFile {
  return (
    !!value &&
    typeof value === "object" &&
    "assetId" in value &&
    typeof value.assetId === "string" &&
    "mediaType" in value &&
    typeof value.mediaType === "string"
  );
}

/** 预览和下载复用认证资产路由，浏览器解码错误也进入统一错误弹窗。 */
function WorkflowMediaItem({ file, outputRunId }: { file: WorkflowFile; outputRunId?: string }) {
  const { runApiTask } = useApiTask();
  const [large, setLarge] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = `/api/v1/workflow-files/${encodeURIComponent(file.assetId)}`;
  const preview = `${download}?preview=1`;
  const image = file.mediaType.startsWith("image/");
  const error = (code?: number) => {
    setFailed(true);
    void runApiTask(
      async () => {
        throw new ApiClientError(
          "WORKFLOW_MEDIA_PREVIEW_FAILED",
          `工作流产物 ${file.name}（${file.mediaType}）加载或解码失败${code ? `，浏览器媒体错误码 ${code}` : ""}；请检查文件是否仍存在、登录是否有效及浏览器是否支持该格式。`,
          0,
        );
      },
      { operation: "预览工作流媒体产物" },
    );
  };
  if (file.deleted) return <article className="wf-media-item"><strong>{file.name}</strong><p>文件已删除</p></article>;
  return (
    <article className="wf-media-item">
      {image && (
        <button
          type="button"
          className="wf-media-image"
          aria-label={`查看大图 ${file.name}`}
          onClick={() => setLarge(true)}
        >
          <img
            src={preview}
            alt={file.name}
            loading="lazy"
            onError={() => error()}
          />
        </button>
      )}
      {file.mediaType.startsWith("video/") && (
        <video
          src={preview}
          controls
          preload="metadata"
          aria-label={file.name}
          onError={(event) => error(event.currentTarget.error?.code)}
        />
      )}
      {file.mediaType.startsWith("audio/") && (
        <audio
          src={preview}
          controls
          preload="metadata"
          aria-label={file.name}
          onError={(event) => error(event.currentTarget.error?.code)}
        />
      )}
      {failed && <p className="wf-error">媒体预览不可用，可下载文件检查。</p>}
      <div className="wf-output-row">
        <strong>{file.name}</strong>
        <a className="wf-file-link" href={download} download={file.name}>
          下载
        </a>
        {outputRunId && !failed && <SaveMediaResultButton target={{
          source: "workflow", taskId: outputRunId, assetId: file.assetId, name: file.name, mediaType: file.mediaType,
        }} />}
      </div>
      {large && (
        <ConfigurationEditorDialog
          variant="confirmation"
          title={file.name}
          description="图片原图预览"
          closeLabel="关闭图片预览"
          busy={false}
          onClose={() => setLarge(false)}
          footer={
            <button
              type="button"
              className="configuration-secondary-action"
              onClick={() => setLarge(false)}
            >
              关闭图片预览
            </button>
          }
        >
          <div className="wf-media-large">
            <img src={preview} alt={file.name} onError={() => error()} />
          </div>
        </ConfigurationEditorDialog>
      )}
    </article>
  );
}

/** 字段保持原顺序，数组索引与对象层级均作为可见上下文保留。 */
function WorkflowValueFields({ entries, outputRunId }: { entries: [string, unknown][]; outputRunId?: string }) {
  return (
    <dl className="wf-value-fields">
      {entries.map(([name, child]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            <WorkflowValueNode value={child} outputRunId={outputRunId} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 文件在所属字段内预览；额外业务字段直接显示，基础文件元数据可单独展开。 */
function WorkflowValueNode({ value, outputRunId }: { value: unknown; outputRunId?: string }) {
  if (isWorkflowFile(value)) {
    const metadata = new Set(["assetId", "name", "mediaType", "size"]);
    const entries = Object.entries(value);
    return (
      <>
        <WorkflowMediaItem file={value} outputRunId={outputRunId} />
        <WorkflowValueFields
          entries={entries.filter(([name]) => !metadata.has(name))} outputRunId={outputRunId}
        />
        <details className="wf-value-branch">
          <summary>文件信息</summary>
          <WorkflowValueFields
            entries={entries.filter(([name]) => metadata.has(name))}
          />
        </details>
      </>
    );
  }
  if (value && typeof value === "object") {
    const array = Array.isArray(value);
    const entries = Object.entries(value).map(
      ([name, child]): [string, unknown] => [array ? `[${name}]` : name, child],
    );
    if (!entries.length) return <code>{array ? "[]" : "{}"}</code>;
    return (
      <details className="wf-value-branch" open>
        <summary>
          {array ? `数组 · ${entries.length} 项` : `对象 · ${entries.length} 个字段`}
        </summary>
        <WorkflowValueFields entries={entries} outputRunId={outputRunId} />
      </details>
    );
  }
  return (
    <pre className="wf-value-scalar">
      {value === undefined
        ? "未提供"
        : value === ""
          ? '""（空字符串）'
          : typeof value === "string"
            ? value
            : JSON.stringify(value)}
    </pre>
  );
}

/** 局域网 HTTP 不提供 Clipboard API 时，兼容复制并恢复焦点；失败交给统一错误出口。 */
async function copyWorkflowJson(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const previous = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  try {
    textarea.select();
    if (!document.execCommand?.("copy"))
      throw new Error("浏览器未能写入剪贴板，请展开完整数据后手动复制 JSON。");
  } finally {
    textarea.remove();
    if (previous instanceof HTMLElement) previous.focus();
  }
}

/** 参数与媒体同时展示，完整 JSON 保留原始值供复制排查。 */
export function WorkflowValueView({
  value,
  label = "输出",
  outputRunId,
}: {
  value: unknown;
  label?: string;
  outputRunId?: string;
}) {
  const { runApiTask } = useApiTask();
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(value, null, 2);
  useEffect(() => setCopied(false), [json]);
  return (
    <div className="wf-value-view">
      {value && typeof value === "object" && !Array.isArray(value) && !isWorkflowFile(value) ? (
        Object.keys(value).length ? (
          <WorkflowValueFields entries={Object.entries(value)} outputRunId={outputRunId} />
        ) : (
          <code>{"{}"}</code>
        )
      ) : (
        <WorkflowValueNode value={value} outputRunId={outputRunId} />
      )}
      <details className="wf-output-data">
        <summary>查看完整{label}数据</summary>
        <pre className="wf-json-output">{json ?? "未提供"}</pre>
      </details>
      <button
        type="button"
        className="wf-text-button"
        disabled={json === undefined}
        aria-label={`复制${label} JSON`}
        onClick={() => {
          setCopied(false);
          if (json === undefined) return;
          void runApiTask(() => copyWorkflowJson(json), {
            operation: `复制工作流${label} JSON`,
          }).then((result) => setCopied(result.status === "success"));
        }}
      >
        {copied ? "已复制" : "复制 JSON"}
      </button>
    </div>
  );
}
