import { SearchSelect } from "../ui/search-select";
import { SaveMediaResultButton } from "../components/media-library-actions";
import "../media-lightbox.css";
import { ChevronLeft, ChevronRight, Download, File, FileAudio, Image as ImageIcon, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AigcOutputItem, AigcOutputKind, AigcOutputPage } from "../../shared/aigc-contracts";
import { aigcTaskAssetUrl, aigcTaskThumbnailUrl, api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import "../aigc-assets.css";

const OUTPUT_KINDS: Array<{ kind: AigcOutputKind; label: string }> = [
  { kind: "image", label: "图片" },
  { kind: "video", label: "视频" },
  { kind: "audio", label: "音频" },
  { kind: "other", label: "其他" },
];

/** 按媒体类型铺平展示全部 AIGC 任务产物。 */
export function AigcOutputsPage() {
  const { runApiTask } = useApiTask();
  const [kind, setKind] = useState<AigcOutputKind>("image");
  const [sort, setSort] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<AigcOutputPage>();
  const [preview, setPreview] = useState<AigcOutputItem>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setError("");
    void runApiTask(() => api.getAigcOutputs(kind, sort, page), {
      operation: "加载 AIGC 产物",
      expected: outputExpected(setError),
    }).then((response) => {
      if (active && response.status === "success") setResult(response.data);
    });
    return () => { active = false; };
  }, [kind, page, runApiTask, sort]);

  const selectKind = (next: AigcOutputKind) => {
    setKind(next);
    setPage(1);
    setPreview(undefined);
  };
  const changeSort = (next: "asc" | "desc") => {
    setSort(next);
    setPage(1);
  };

  return <main className="aigc-assets-page">
    <header className="aigc-assets-heading">
      <div><span>AIGC WORKBENCH</span><h1>产物查看</h1></div>
      <label>创建时间<SearchSelect
        ariaLabel="产物创建时间排序"
        value={sort}
        onChange={(next) => changeSort(next as "asc" | "desc")}
        options={[
          { value: "desc", label: "最新在前" },
          { value: "asc", label: "最早在前" },
        ]}
      /></label>
    </header>

    <div className="aigc-assets-tabs" role="tablist" aria-label="产物类型">
      {OUTPUT_KINDS.map((item) => <button key={item.kind} type="button" role="tab" aria-selected={kind === item.kind} className={kind === item.kind ? "is-active" : undefined} onClick={() => selectKind(item.kind)}><span>{item.label}</span><strong>{result?.counts[item.kind] ?? 0}</strong></button>)}
    </div>

    {error ? <p className="configuration-inline-error">{error}</p> : null}
    {result?.items.length ? <div className="aigc-output-grid">
      {result.items.map((item) => <OutputCard key={`${item.taskId}-${item.id}`} item={item} onPreview={() => setPreview(item)} />)}
    </div> : !error && result ? <div className="aigc-output-empty"><ImageIcon size={30} aria-hidden="true" /><strong>暂无{OUTPUT_KINDS.find((item) => item.kind === kind)?.label}产物</strong></div> : <p className="aigc-output-loading" role="status">正在加载产物…</p>}

    {result && result.totalPages > 1 ? <nav className="aigc-output-pagination" aria-label="产物分页"><button type="button" aria-label="上一页" title="上一页" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={17} /></button><span>第 {result.page} / {result.totalPages} 页，共 {result.total} 项</span><button type="button" aria-label="下一页" title="下一页" disabled={page >= result.totalPages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button></nav> : null}

    {preview ? <OutputPreview item={preview} onClose={() => setPreview(undefined)} /> : null}
  </main>;
}

function OutputCard({ item, onPreview }: { item: AigcOutputItem; onPreview: () => void }) {
  const source = aigcTaskAssetUrl(item.taskId, item.id);
  const [thumbnailState, setThumbnailState] = useState<"loading" | "loaded" | "failed">("loading");
  return <article className="aigc-output-card">
    <button type="button" className="aigc-output-card__preview" aria-label={`预览 ${item.name}`} onClick={onPreview}>
      {item.kind === "image" && thumbnailState !== "loaded" ? <span className="aigc-output-card__type" style={{ gridArea: "1 / 1" }} role="status"><ImageIcon size={24} aria-hidden="true" />{thumbnailState === "failed" ? "缩略图加载失败" : "正在加载"}</span> : null}
      {item.kind === "image" ? <img style={{ gridArea: "1 / 1", opacity: thumbnailState === "loaded" ? 1 : 0 }} src={aigcTaskThumbnailUrl(item.taskId, item.id)} alt={item.name} loading="lazy" onLoad={() => setThumbnailState("loaded")} onError={() => setThumbnailState("failed")} /> : null}
      {item.kind === "video" ? <video src={source} preload="metadata" muted aria-label={item.name} /> : null}
      {item.kind === "audio" ? <span className="aigc-output-card__type"><FileAudio size={34} aria-hidden="true" />音频</span> : null}
      {item.kind === "other" ? <span className="aigc-output-card__type"><File size={34} aria-hidden="true" />{fileExtension(item.name)}</span> : null}
    </button>
    {item.kind === "audio" ? <audio src={source} controls preload="metadata" aria-label={`播放 ${item.name}`} /> : null}
    <footer><span><strong title={item.name}>{item.name}</strong><small>{formatAigcOutputTime(item.taskCreatedAt)}</small><small>{formatFileSize(item.size)} · {item.interfaceName}</small></span><a href={aigcTaskAssetUrl(item.taskId, item.id, true)} download={item.name} aria-label={`下载 ${item.name}`} title="下载"><Download size={16} /></a><SaveMediaResultButton target={{ ...item, source: "aigc", assetId: item.id }} /></footer>
  </article>;
}

function OutputPreview({ item, onClose }: { item: AigcOutputItem; onClose: () => void }) {
  const source = aigcTaskAssetUrl(item.taskId, item.id);
  return <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={`${item.name} 预览`}><button type="button" className="media-lightbox__close" aria-label="关闭产物预览" onClick={onClose}><X size={20} /></button><div className="media-lightbox__stage">
    {item.kind === "image" ? <img src={source} alt={item.name} /> : null}
    {item.kind === "video" ? <video src={source} controls autoPlay /> : null}
    {item.kind === "audio" ? <div className="aigc-output-audio-preview"><FileAudio size={48} aria-hidden="true" /><strong>{item.name}</strong><audio src={source} controls autoPlay /></div> : null}
    {item.kind === "other" ? <div className="aigc-output-audio-preview"><File size={48} aria-hidden="true" /><strong>{item.name}</strong><a href={aigcTaskAssetUrl(item.taskId, item.id, true)} download={item.name}>下载文件</a></div> : null}
  </div></div>;
}

function outputExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return { VALIDATION_FAILED: show, NOT_FOUND: show };
}

function fileExtension(name: string): string {
  const extension = name.includes(".") ? name.split(".").at(-1) : undefined;
  return extension?.toUpperCase() || "文件";
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 将产物所属任务的创建时间格式化为紧凑的本地时间。 */
function formatAigcOutputTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
