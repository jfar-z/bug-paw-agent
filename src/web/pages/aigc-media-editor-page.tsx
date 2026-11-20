import { Button, IconButton, NumberField, TextField } from "../ui/controls";
import { Dialog } from "../ui/dialog";
import { Tabs } from "../ui/tabs";
import { Checkbox } from "../ui/choice";
import { SearchSelect } from "../ui/search-select";
import {
  AudioLines, ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Download, Film, FolderOpen,
  GripVertical, Image as ImageIcon, ImagePlus, LoaderCircle, Pause, Play, Plus, Scissors,
  Settings2, Trash2, Volume2, VolumeX, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AigcMediaClip, AigcMediaClipInput, AigcMediaProject, AigcMediaProjectKind, AigcMediaRenderJob,
} from "../../shared/aigc-media-editor-contracts";
import type { AigcOutputItem, AigcOutputKind } from "../../shared/aigc-contracts";
import { aigcMediaRenderUrl, aigcTaskAssetUrl, aigcTaskThumbnailUrl, api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";

import "../aigc-media-editor.css";

/** 提供 AIGC 产物的单轨拼接、连续预览和低资源串行导出。 */
export function AigcMediaEditorPage() {
  const { runApiTask } = useApiTask();
  const [projects, setProjects] = useState<AigcMediaProject[]>([]);
  const [project, setProject] = useState<AigcMediaProject>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryKind, setLibraryKind] = useState<AigcOutputKind>("video");
  const [outputs, setOutputs] = useState<AigcOutputItem[]>([]);
  const [outputsLoading, setOutputsLoading] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState("");
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [renderJob, setRenderJob] = useState<AigcMediaRenderJob>();
  const [showRenderedOutput, setShowRenderedOutput] = useState(false);
  const [draggedClipId, setDraggedClipId] = useState("");
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveSequenceRef = useRef(0);
  const pendingSavesRef = useRef(0);
  const persistedProjectsRef = useRef(new Map<string, AigcMediaProject>());
  const currentProjectIdRef = useRef("");
  const creatingProject = useRef(false);

  const selectedClip = project?.clips.find((clip) => clip.id === selectedClipId);
  const totalDurationMs = useMemo(() => project?.clips.reduce((total, clip) => total + clipDuration(clip), 0) ?? 0, [project]);
  const activePosition = useMemo(() => locatePlayhead(project?.clips ?? [], playheadMs), [playheadMs, project?.clips]);
  const activeClip = project?.clips[activePosition.index];

  const refreshProjects = useCallback(async (preferredId?: string, preserveEditorState = false) => {
    setError("");
    const result = await runApiTask(async () => {
      const document = await api.getAigcMediaProjects();
      if (document.projects.length) return document;
      const created = await api.createAigcMediaProject({ kind: "video" });
      return { projects: [created] };
    }, { operation: "加载剪辑工程", expected: editorExpected(setError) });
    if (result.status !== "success") return;
    persistedProjectsRef.current = new Map(result.data.projects.map((item) => [item.id, item]));
    setProjects(result.data.projects);
    const selected = result.data.projects.find((candidate) => candidate.id === preferredId)
      ?? result.data.projects.find((candidate) => candidate.id === project?.id)
      ?? result.data.projects[0];
    setProject(selected);
    currentProjectIdRef.current = selected?.id ?? "";
    if (!preserveEditorState) {
      setSelectedClipId(selected?.clips[0]?.id ?? "");
      setPlayheadMs(0);
      setRenderJob(undefined);
      setShowRenderedOutput(false);
    }
  }, [project?.id, runApiTask]);

  useEffect(() => {
    void refreshProjects().finally(() => setLoading(false));
    // 首次进入只加载一次；后续刷新由明确操作触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!libraryOpen || !project) return;
    let active = true;
    setOutputsLoading(true);
    void runApiTask(() => api.getAigcOutputs(libraryKind, "desc", 1, 96), {
      operation: "加载 AIGC 产物", expected: editorExpected(setError),
    }).then((result) => {
      if (active && result.status === "success") setOutputs(result.data.items);
    }).finally(() => { if (active) setOutputsLoading(false); });
    return () => { active = false; };
  }, [libraryKind, libraryOpen, project, runApiTask]);

  useEffect(() => {
    if (!renderJob || (renderJob.status !== "queued" && renderJob.status !== "running")) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void runApiTask(() => api.getAigcMediaRender(renderJob.id), {
        operation: "刷新导出状态", expected: editorExpected(setError),
      }).then((result) => {
        if (!active || result.status !== "success") return;
        setRenderJob(result.data);
        if (result.data.status === "succeeded") {
          setShowRenderedOutput(true);
          void refreshProjects(project?.id, true);
        }
      });
    }, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [project?.id, refreshProjects, renderJob, runApiTask]);

  const saveProject = useCallback(async (next: AigcMediaProject) => {
    const sequence = ++saveSequenceRef.current;
    pendingSavesRef.current += 1;
    setSaving(true);
    const operation = saveQueueRef.current.then(async () => {
      setError("");
      const persisted = persistedProjectsRef.current.get(next.id);
      const result = await runApiTask(() => api.updateAigcMediaProject(next.id, {
        revision: persisted?.revision ?? next.revision, name: next.name, clips: next.clips.map(toClipInput),
      }), { operation: "保存剪辑工程", expected: editorExpected(setError) });
      if (result.status !== "success") return undefined;
      persistedProjectsRef.current.set(result.data.id, result.data);
      setProjects((current) => [result.data, ...current.filter((candidate) => candidate.id !== result.data.id)]);
      // 后续操作可能已在本地形成更新状态，旧响应不能覆盖它。
      if (sequence === saveSequenceRef.current && currentProjectIdRef.current === result.data.id) setProject(result.data);
      return result.data;
    }).finally(() => {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) setSaving(false);
    });
    saveQueueRef.current = operation;
    return operation;
  }, [runApiTask]);

  const createProject = async (kind: AigcMediaProjectKind) => {
    if (creatingProject.current) return;
    setError("");
    const existing = projects.find((candidate) => candidate.kind === kind);
    if (existing) return selectProject(existing);
    creatingProject.current = true;
    try {
      const result = await runApiTask(() => api.createAigcMediaProject({ kind }), {
        operation: "新建剪辑工程", expected: editorExpected(setError),
      });
      if (result.status === "success") {
        persistedProjectsRef.current.set(result.data.id, result.data);
        setProjects((current) => [result.data, ...current]);
        selectProject(result.data);
      }
    } finally {
      creatingProject.current = false;
    }
  };

  const selectProject = (next: AigcMediaProject) => {
    currentProjectIdRef.current = next.id;
    setProject(next);
    setProjectMenuOpen(false);
    setLibraryOpen(false);
    setSelectedClipId(next.clips[0]?.id ?? "");
    setPlayheadMs(0);
    setPlaying(false);
    setRenderJob(undefined);
    setShowRenderedOutput(false);
  };

  const openLibrary = () => {
    if (!project) return;
    setLibraryKind(project.kind === "audio" ? "audio" : "video");
    setLibraryOpen(true);
  };

  const addOutput = async (output: AigcOutputItem) => {
    if (!project || saving || project.clips.some((clip) => clip.source.taskId === output.taskId && clip.source.assetId === output.id)) return;
    const input: AigcMediaClipInput = {
      id: crypto.randomUUID(), source: { taskId: output.taskId, assetId: output.id }, trimStartMs: 0,
      ...(output.kind === "image" ? { imageDurationMs: 3000 } : {}),
    };
    const optimistic = { ...project, clips: [...project.clips, provisionalClip(input, output)] };
    const saved = await saveProject(optimistic);
    if (saved) {
      setSelectedClipId(saved.clips.at(-1)?.id ?? "");
      setLibraryOpen(false);
    }
  };

  const updateClip = async (clipId: string, patch: Partial<AigcMediaClip>) => {
    if (!project) return;
    const next = { ...project, clips: project.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) };
    setProject(next);
    await saveProject(next);
  };

  const removeClip = async (clipId: string) => {
    if (!project) return;
    const index = project.clips.findIndex((clip) => clip.id === clipId);
    const saved = await saveProject({ ...project, clips: project.clips.filter((clip) => clip.id !== clipId) });
    if (saved) setSelectedClipId(saved.clips[Math.min(index, saved.clips.length - 1)]?.id ?? "");
  };

  const moveClip = async (clipId: string, targetIndex: number) => {
    if (!project) return;
    const sourceIndex = project.clips.findIndex((clip) => clip.id === clipId);
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= project.clips.length || sourceIndex === targetIndex) return;
    const clips = [...project.clips];
    const [moved] = clips.splice(sourceIndex, 1);
    clips.splice(targetIndex, 0, moved);
    await saveProject({ ...project, clips });
  };

  const startRender = async () => {
    if (!project || !project.clips.length || saving) return;
    setError("");
    const result = await runApiTask(() => api.renderAigcMediaProject(project.id), {
      operation: "导出剪辑工程", expected: editorExpected(setError),
    });
    if (result.status === "success") {
      setRenderJob(result.data);
      setShowRenderedOutput(false);
    }
  };

  const cancelRender = async () => {
    if (!renderJob) return;
    const result = await runApiTask(() => api.cancelAigcMediaRender(renderJob.id), {
      operation: "取消媒体导出", expected: editorExpected(setError),
    });
    if (result.status === "success") setRenderJob(result.data);
  };

  if (loading || !project) return <main className="aigc-media-editor-page is-loading"><LoaderCircle size={26} aria-hidden="true" /><span>正在加载剪辑工程…</span></main>;

  return <main className="aigc-media-editor-page">
    <header className="aigc-media-editor-header">
      <div className="aigc-media-editor-heading">
        <span>AIGC WORKBENCH</span>
        <div><h1>轻剪辑</h1><button type="button" className="aigc-media-editor-project-switcher" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen((open) => !open)}><FolderOpen size={14} aria-hidden="true" /><span>{project.name}</span><ChevronDown size={13} aria-hidden="true" /></button></div>
        {projectMenuOpen ? <ProjectMenu projects={projects} current={project} onClose={() => setProjectMenuOpen(false)} onSelect={selectProject} onCreate={(kind) => void createProject(kind)} /> : null}
      </div>
      <div className="aigc-media-editor-actions">
        <Tabs<AigcMediaProjectKind> label="工程类型" panelId="media-project-panel" value={project.kind} manual
          onChange={(kind) => { if (kind !== project.kind) void createProject(kind); }}
          items={[
            { id: "video", label: <><Film size={15} aria-hidden="true" />视频</> },
            { id: "audio", label: <><AudioLines size={15} aria-hidden="true" />音频</> },
          ]} />
        <Button variant="primary" loading={renderJob?.status === "queued" || renderJob?.status === "running"}
          disabled={!project.clips.length || saving} onClick={() => void startRender()}
          icon={<Download size={16} aria-hidden="true" />}>导出</Button>
      </div>
    </header>

    {error ? <p className="configuration-inline-error aigc-media-editor-error">{error}</p> : null}
    {renderJob ? <RenderStatus job={renderJob} onCancel={() => void cancelRender()} /> : null}

    <div id="media-project-panel" role="tabpanel" aria-labelledby={`media-project-panel-${project.kind}`}>
    <section className="aigc-media-editor-workspace" aria-label="剪辑工作区">
      <EditorPreview project={project} activeClip={activeClip} activeOffsetMs={activePosition.offsetMs} totalDurationMs={totalDurationMs} playheadMs={playheadMs} playing={playing} renderJob={showRenderedOutput ? renderJob : undefined} onPlayChange={setPlaying} onPlayheadChange={setPlayheadMs} onOpenLibrary={openLibrary} onTimelinePreview={() => setShowRenderedOutput(false)} />
      <EditorInspector project={project} clip={selectedClip} saving={saving} onProjectChange={(patch) => setProject((current) => current ? { ...current, ...patch } : current)} onProjectSave={() => void saveProject(project)} onClipChange={(patch) => selectedClip && setProject((current) => current ? { ...current, clips: current.clips.map((item) => item.id === selectedClip.id ? { ...item, ...patch } : item) } : current)} onClipSave={() => void saveProject(project)} onClipCommit={(patch) => selectedClip && void updateClip(selectedClip.id, patch)} />
    </section>

    <section className="aigc-media-editor-timeline" aria-label="单轨时间线">
      <header><div><Scissors size={16} aria-hidden="true" /><h2>单轨时间线</h2><span>{project.kind === "video" ? "画面与原音" : "连续音频"}</span></div><Button onClick={openLibrary} icon={<Plus size={16} aria-hidden="true" />}>添加片段</Button></header>
      <div className="aigc-media-editor-ruler" aria-hidden="true"><span>00:00</span><span>{formatTime(totalDurationMs * .25)}</span><span>{formatTime(totalDurationMs * .5)}</span><span>{formatTime(totalDurationMs * .75)}</span><span>{formatTime(totalDurationMs)}</span></div>
      {project.clips.length ? <div className="aigc-media-editor-track">{project.clips.map((clip, index) => <TimelineClip key={clip.id} clip={clip} index={index} count={project.clips.length} selected={clip.id === selectedClipId} saving={saving} onSelect={() => { setSelectedClipId(clip.id); setPlayheadMs(clipStart(project.clips, index)); setShowRenderedOutput(false); }} onMove={(target) => void moveClip(clip.id, target)} onRemove={() => void removeClip(clip.id)} onDragStart={() => setDraggedClipId(clip.id)} onDrop={() => { if (draggedClipId) void moveClip(draggedClipId, index); setDraggedClipId(""); }} />)}</div> : <button type="button" className="aigc-media-editor-empty-track" onClick={openLibrary}><Plus size={18} aria-hidden="true" /><span>添加第一个片段</span></button>}
    </section>

    </div>

    {libraryOpen ? <AssetLibrary project={project} kind={libraryKind} items={outputs} loading={outputsLoading} onKindChange={setLibraryKind} onAdd={(item) => void addOutput(item)} onClose={() => setLibraryOpen(false)} /> : null}
  </main>;
}

/** 标题旁的工程切换器承载旧工程与新建入口。 */
function ProjectMenu({ projects, current, onClose, onSelect, onCreate }: { projects: AigcMediaProject[]; current: AigcMediaProject; onClose: () => void; onSelect: (project: AigcMediaProject) => void; onCreate: (kind: AigcMediaProjectKind) => void }) {
  return <div className="aigc-media-editor-project-menu" role="dialog" aria-label="剪辑工程">
    <header><span>剪辑工程</span><IconButton label="关闭工程列表" onClick={onClose}><X size={16} /></IconButton></header>
    <div className="aigc-media-editor-project-list">{projects.map((item) => <button key={item.id} type="button" className={item.id === current.id ? "is-current" : undefined} onClick={() => onSelect(item)}><span><strong>{item.name}</strong><small>{formatModified(item.updatedAt)}</small></span><span>{item.kind === "video" ? "视频" : "音频"}</span></button>)}</div>
    <footer><Button onClick={() => onCreate("video")}><Film size={14} aria-hidden="true" />新建视频工程</Button><Button onClick={() => onCreate("audio")}><AudioLines size={14} aria-hidden="true" />新建音频工程</Button></footer>
  </div>;
}

/** 在浏览器中按时间线逐段播放，避免预览阶段占用服务端转码资源。 */
function EditorPreview({ project, activeClip, activeOffsetMs, totalDurationMs, playheadMs, playing, renderJob, onPlayChange, onPlayheadChange, onOpenLibrary, onTimelinePreview }: { project: AigcMediaProject; activeClip?: AigcMediaClip; activeOffsetMs: number; totalDurationMs: number; playheadMs: number; playing: boolean; renderJob?: AigcMediaRenderJob; onPlayChange: (playing: boolean) => void; onPlayheadChange: (value: number) => void; onOpenLibrary: () => void; onTimelinePreview: () => void }) {
  const mediaRef = useRef<HTMLMediaElement>(null);
  const imageStartedAt = useRef(0);
  const clipStartMs = playheadMs - activeOffsetMs;
  const source = activeClip ? aigcTaskAssetUrl(activeClip.source.taskId, activeClip.source.assetId) : "";

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !activeClip || activeClip.kind === "image" || renderJob) return;
    const expected = (activeClip.trimStartMs + activeOffsetMs) / 1000;
    if (Math.abs(media.currentTime - expected) > .35) media.currentTime = expected;
    if (playing) void media.play().catch(() => onPlayChange(false));
    else media.pause();
  }, [activeClip, activeOffsetMs, onPlayChange, playing, renderJob]);

  useEffect(() => {
    if (!playing || activeClip?.kind !== "image" || renderJob) return;
    imageStartedAt.current = performance.now() - activeOffsetMs;
    let frame = 0;
    const tick = (now: number) => {
      const elapsed = now - imageStartedAt.current;
      if (elapsed >= clipDuration(activeClip)) advancePlayhead(project.clips, clipStartMs + clipDuration(activeClip), totalDurationMs, onPlayChange, onPlayheadChange);
      else { onPlayheadChange(clipStartMs + elapsed); frame = requestAnimationFrame(tick); }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [activeClip, activeOffsetMs, clipStartMs, onPlayChange, onPlayheadChange, playing, project.clips, renderJob, totalDurationMs]);

  const mediaTimeUpdate = () => {
    const media = mediaRef.current;
    if (!media || !activeClip) return;
    const elapsed = Math.max(0, media.currentTime * 1000 - activeClip.trimStartMs);
    if (elapsed >= clipDuration(activeClip) - 40) advancePlayhead(project.clips, clipStartMs + clipDuration(activeClip), totalDurationMs, onPlayChange, onPlayheadChange);
    else onPlayheadChange(clipStartMs + elapsed);
  };

  return <div className={project.kind === "video" ? "aigc-media-editor-preview" : "aigc-media-editor-preview is-audio"}>
    <div className="aigc-media-editor-preview__stage">{renderJob?.status === "succeeded" ? <div className="aigc-media-editor-rendered-preview">{project.kind === "video" ? <video src={aigcMediaRenderUrl(renderJob.id)} controls preload="metadata" /> : <audio src={aigcMediaRenderUrl(renderJob.id)} controls preload="metadata" />}<Button onClick={onTimelinePreview}>返回时间线预览</Button></div> : activeClip ? <>{activeClip.kind === "image" ? <img src={source} alt={activeClip.name} /> : activeClip.kind === "video" ? <video ref={(node) => { mediaRef.current = node; }} src={source} muted={Boolean(activeClip.muted)} preload="metadata" onTimeUpdate={mediaTimeUpdate} onEnded={mediaTimeUpdate} /> : <div className="aigc-media-editor-audio-stage"><AudioLines size={44} aria-hidden="true" /><strong>{activeClip.name}</strong><audio ref={(node) => { mediaRef.current = node; }} src={source} preload="metadata" onTimeUpdate={mediaTimeUpdate} onEnded={mediaTimeUpdate} /></div>}</> : <div className="aigc-media-editor-preview__empty">{project.kind === "video" ? <Clapperboard size={38} aria-hidden="true" /> : <AudioLines size={38} aria-hidden="true" />}<strong>{project.kind === "video" ? "空视频工程" : "空音频工程"}</strong><Button onClick={onOpenLibrary} icon={<ImagePlus size={16} aria-hidden="true" />}>添加产物</Button></div>}</div>
    <div className="aigc-media-editor-transport"><button type="button" aria-label={playing ? "暂停预览" : "播放预览"} title={playing ? "暂停预览" : "播放预览"} disabled={!activeClip || Boolean(renderJob)} onClick={() => onPlayChange(!playing)}>{playing ? <Pause size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}</button><span><strong>{formatTime(playheadMs, true)}</strong><small>/ {formatTime(totalDurationMs, true)}</small></span><input type="range" aria-label="时间线播放位置" min="0" max={Math.max(totalDurationMs, 1)} step="50" value={Math.min(playheadMs, totalDurationMs)} disabled={!activeClip || Boolean(renderJob)} onChange={(event) => { onPlayChange(false); onPlayheadChange(Number(event.target.value)); }} /><Volume2 size={17} aria-hidden="true" /></div>
  </div>;
}

/** 根据当前选择显示工程参数或片段裁剪参数。 */
function EditorInspector({ project, clip, saving, onProjectChange, onProjectSave, onClipChange, onClipSave, onClipCommit }: { project: AigcMediaProject; clip?: AigcMediaClip; saving: boolean; onProjectChange: (patch: Partial<AigcMediaProject>) => void; onProjectSave: () => void; onClipChange: (patch: Partial<AigcMediaClip>) => void; onClipSave: () => void; onClipCommit: (patch: Partial<AigcMediaClip>) => void }) {
  return <aside className="aigc-media-editor-inspector" aria-label="工程参数">
    <header><Settings2 size={16} aria-hidden="true" /><h2>{clip ? "片段参数" : "工程参数"}</h2><span>{saving ? "保存中" : "已保存"}</span></header>
    {clip ? <><div className="aigc-media-editor-selected-name"><strong title={clip.name}>{clip.name}</strong><small>{clip.kind === "image" ? "图片" : clip.kind === "video" ? "视频" : "音频"}</small></div>{clip.kind === "image" ? <label>展示时长<span><NumberField min="0.5" max="30" step="0.5" value={(clip.imageDurationMs ?? 3000) / 1000} onChange={(event) => onClipChange({ imageDurationMs: Math.round(Number(event.target.value) * 1000) })} onBlur={onClipSave} />秒</span></label> : <><label>起点<span><NumberField min="0" max={(clip.trimEndMs ?? clip.sourceDurationMs) / 1000 - .001} step="0.1" value={clip.trimStartMs / 1000} onChange={(event) => onClipChange({ trimStartMs: Math.round(Number(event.target.value) * 1000) })} onBlur={onClipSave} />秒</span></label><label>终点<span><NumberField min={clip.trimStartMs / 1000 + .001} max={clip.sourceDurationMs / 1000} step="0.1" value={(clip.trimEndMs ?? clip.sourceDurationMs) / 1000} onChange={(event) => onClipChange({ trimEndMs: Math.round(Number(event.target.value) * 1000) })} onBlur={onClipSave} />秒</span></label></>}{clip.kind === "video" && clip.hasAudio ? <label className="aigc-media-editor-mute"><Checkbox checked={Boolean(clip.muted)} onChange={(event) => onClipCommit({ muted: event.target.checked })} />{clip.muted ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}片段原音</label> : null}<div className="aigc-media-editor-codec"><span>片段时长</span><strong>{formatTime(clipDuration(clip), true)}</strong><span>原始时长</span><strong>{formatTime(clip.sourceDurationMs, true)}</strong></div></> : <><label>工程名称<TextField maxLength={80} value={project.name} onChange={(event) => onProjectChange({ name: event.target.value })} onBlur={onProjectSave} /></label>{project.kind === "video" ? <><label>画面尺寸<SearchSelect
      ariaLabel="画面尺寸"
      value="1920x1080"
      disabled
      options={[{ value: "1920x1080", label: "1920 × 1080" }]}
    /></label><label>帧率<SearchSelect
      ariaLabel="帧率"
      value="30"
      disabled
      options={[{ value: "30", label: "30 fps" }]}
    /></label><div className="aigc-media-editor-codec"><span>视频</span><strong>H.264</strong><span>音频</span><strong>AAC</strong></div></> : <><label>导出格式<SearchSelect
      ariaLabel="导出格式"
      value="mp3"
      disabled
      options={[{ value: "mp3", label: "MP3" }]}
    /></label><label>采样率<SearchSelect
      ariaLabel="采样率"
      value="48000"
      disabled
      options={[{ value: "48000", label: "48 kHz" }]}
    /></label><div className="aigc-media-editor-codec"><span>声道</span><strong>立体声</strong><span>码率</span><strong>192 kbps</strong></div></>}</>}
    <footer><span>片段</span><strong>{project.clips.length}</strong><span>总时长</span><strong>{formatTime(project.clips.reduce((total, item) => total + clipDuration(item), 0), true)}</strong></footer>
  </aside>;
}

/** 横向时间线片段支持拖动与移动端显式排序按钮。 */
function TimelineClip({ clip, index, count, selected, saving, onSelect, onMove, onRemove, onDragStart, onDrop }: { clip: AigcMediaClip; index: number; count: number; selected: boolean; saving: boolean; onSelect: () => void; onMove: (target: number) => void; onRemove: () => void; onDragStart: () => void; onDrop: () => void }) {
  return <article className={selected ? "aigc-media-editor-clip is-selected" : "aigc-media-editor-clip"} draggable={!saving} onDragStart={onDragStart} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><button type="button" className="aigc-media-editor-clip__main" onClick={onSelect} aria-label={`选择片段 ${clip.name}`}><GripVertical size={14} aria-hidden="true" />{clip.kind === "image" ? <img src={aigcTaskThumbnailUrl(clip.source.taskId, clip.source.assetId)} alt="" /> : clip.kind === "video" ? <Film size={20} aria-hidden="true" /> : <AudioLines size={20} aria-hidden="true" />}<span><strong title={clip.name}>{clip.name}</strong><small>{formatTime(clipDuration(clip), true)}{clip.kind === "video" && clip.hasAudio && !clip.muted ? " · 原音" : ""}</small></span></button><footer><button type="button" aria-label="向前移动" title="向前移动" disabled={saving || index === 0} onClick={() => onMove(index - 1)}><ChevronLeft size={14} /></button><button type="button" aria-label="向后移动" title="向后移动" disabled={saving || index >= count - 1} onClick={() => onMove(index + 1)}><ChevronRight size={14} /></button><button type="button" aria-label="移除片段" title="移除片段" disabled={saving} onClick={onRemove}><Trash2 size={14} /></button></footer></article>;
}

/** 从真实 AIGC 产物中选择与当前工程兼容的素材。 */
function AssetLibrary({ project, kind, items, loading, onKindChange, onAdd, onClose }: { project: AigcMediaProject; kind: AigcOutputKind; items: AigcOutputItem[]; loading: boolean; onKindChange: (kind: AigcOutputKind) => void; onAdd: (item: AigcOutputItem) => void; onClose: () => void }) {
  const kinds: { id: AigcOutputKind; label: string }[] = project.kind === "video"
    ? [{ id: "video", label: "视频" }, { id: "image", label: "图片" }]
    : [{ id: "audio", label: "音频" }];
  return <Dialog title="选择产物" closeLabel="关闭产物库" onClose={onClose} drawer="right" className="aigc-media-editor-library">
    <Tabs label="可用产物类型" panelId="editor-library-panel" items={kinds} value={kind} onChange={onKindChange} />
    <div id="editor-library-panel" role="tabpanel" aria-labelledby={`editor-library-panel-${kind}`} tabIndex={0}>
      {loading ? <div className="aigc-media-editor-library__empty"><LoaderCircle className="is-spinning" size={24} aria-hidden="true" /><span>正在加载产物…</span></div> : items.length ? <div className="aigc-media-editor-library__items">{items.map((item) => <button key={`${item.taskId}-${item.id}`} type="button" onClick={() => onAdd(item)}>{item.kind === "image" ? <img src={aigcTaskThumbnailUrl(item.taskId, item.id)} alt="" /> : item.kind === "video" ? <video src={aigcTaskAssetUrl(item.taskId, item.id)} muted preload="metadata" /> : <AudioLines size={26} aria-hidden="true" />}<span><strong title={item.name}>{item.name}</strong><small>{formatBytes(item.size)}</small></span><Plus size={16} aria-hidden="true" /></button>)}</div> : <div className="aigc-media-editor-library__empty"><ImageIcon size={26} aria-hidden="true" /><span>暂无可用{kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}产物</span></div>}
    </div>
  </Dialog>;
}

/** 展示队列位置、进度和可取消状态。 */
function RenderStatus({ job, onCancel }: { job: AigcMediaRenderJob; onCancel: () => void }) {
  const active = job.status === "queued" || job.status === "running";
  return <section className={`aigc-media-editor-render-status is-${job.status}`} role="status"><span>{job.status === "queued" ? `排队中 · 第 ${job.queuePosition ?? 1} 位` : job.status === "running" ? `正在导出 · ${Math.round(job.progress * 100)}%` : job.status === "succeeded" ? "导出完成" : job.status === "cancelled" ? "导出已取消" : job.error ?? "导出失败"}</span>{job.status === "succeeded" && job.fileName ? <a href={aigcMediaRenderUrl(job.id, true)} download={job.fileName}><Download size={14} aria-hidden="true" />下载</a> : null}{active ? <Button onClick={onCancel}>取消</Button> : null}</section>;
}

function toClipInput(clip: AigcMediaClip): AigcMediaClipInput {
  return { id: clip.id, source: { ...clip.source }, trimStartMs: clip.trimStartMs, ...(clip.trimEndMs !== undefined ? { trimEndMs: clip.trimEndMs } : {}), ...(clip.imageDurationMs !== undefined ? { imageDurationMs: clip.imageDurationMs } : {}), ...(clip.muted ? { muted: true } : {}) };
}

function provisionalClip(input: AigcMediaClipInput, output: AigcOutputItem): AigcMediaClip {
  return { ...input, name: output.name, mediaType: output.mediaType, kind: output.kind === "image" ? "image" : output.kind === "video" ? "video" : "audio", sourceDurationMs: input.imageDurationMs ?? 1, hasAudio: output.kind !== "image" };
}

function clipDuration(clip: AigcMediaClip): number {
  return clip.kind === "image" ? clip.imageDurationMs ?? clip.sourceDurationMs : Math.max(1, (clip.trimEndMs ?? clip.sourceDurationMs) - clip.trimStartMs);
}

function clipStart(clips: AigcMediaClip[], index: number): number {
  return clips.slice(0, index).reduce((total, clip) => total + clipDuration(clip), 0);
}

function locatePlayhead(clips: AigcMediaClip[], playheadMs: number): { index: number; offsetMs: number } {
  let cursor = 0;
  for (let index = 0; index < clips.length; index += 1) {
    const duration = clipDuration(clips[index]);
    if (playheadMs < cursor + duration || index === clips.length - 1) return { index, offsetMs: Math.max(0, Math.min(duration, playheadMs - cursor)) };
    cursor += duration;
  }
  return { index: 0, offsetMs: 0 };
}

function advancePlayhead(clips: AigcMediaClip[], nextMs: number, totalMs: number, onPlayChange: (playing: boolean) => void, onPlayheadChange: (value: number) => void) {
  if (!clips.length || nextMs >= totalMs - 1) { onPlayChange(false); onPlayheadChange(0); }
  else onPlayheadChange(nextMs + 1);
}

function formatTime(milliseconds: number, tenths = false): string {
  const safe = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0);
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const suffix = tenths ? `.${Math.floor((safe % 1000) / 100)}` : "";
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${suffix}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function formatModified(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function editorExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  return { VALIDATION_FAILED: (error) => setError(error.message), CONFLICT: (error) => setError(error.message), NOT_FOUND: (error) => setError(error.message) };
}
