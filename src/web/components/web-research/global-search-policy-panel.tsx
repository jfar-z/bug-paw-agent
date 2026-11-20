import { Button, NumberField, Textarea } from "../../ui/controls";
import { Checkbox } from "../../ui/choice";
import { SearchSelect } from "../../ui/search-select";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

import type { WebResearchGlobalConfig, WebResearchSettingsDocument } from "../../../shared/web-research-contracts";

interface GlobalSearchPolicyPanelProps {
  value: WebResearchGlobalConfig;
  egressProfiles: WebResearchSettingsDocument["egressProfiles"];
  error?: string;
  onChange(value: WebResearchGlobalConfig): void;
}

/** 编辑应用于全部搜索渠道和页面读取的全局策略。 */
export function GlobalSearchPolicyPanel(props: GlobalSearchPolicyPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const update = <Key extends keyof WebResearchGlobalConfig>(key: Key, value: WebResearchGlobalConfig[Key]) => {
    props.onChange({ ...props.value, [key]: value });
  };
  const updateContentType = (contentType: "text/html" | "text/plain", enabled: boolean) => {
    const allowedContentTypes = enabled
      ? [...new Set([...props.value.allowedContentTypes, contentType])]
      : props.value.allowedContentTypes.filter((type) => type !== contentType);
    // 服务端要求至少一种内容类型；最后一个选项不能在界面中被取消。
    if (allowedContentTypes.length > 0) update("allowedContentTypes", allowedContentTypes);
  };

  return <section className="configuration-form-card">
    <div className="configuration-section__heading">
      <div><span>03</span><h2>全局检索策略</h2></div>
      <Button type="button" className="configuration-secondary-action" aria-label={`${expanded ? "收起" : "展开"}全局检索策略`} aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}{expanded ? "收起" : "展开"}</Button>
    </div>
    <div className="configuration-button-row"><span>最多 {props.value.maxResults} 条结果</span><span>页面读取 {formatSeconds(props.value.webRead.timeoutMs)}</span><span>{props.value.httpsOnly ? "仅 HTTPS" : "允许 HTTP 与 HTTPS"}</span></div>
    {expanded ? <>
      <p className="configuration-help">应用于所有搜索渠道及页面读取</p>
      <label><span>页面读取出口<small>出口地址、网段和凭证由部署环境管理。</small></span><SearchSelect
        ariaLabel="页面读取出口"
        value={props.value.webRead.egressProfileId}
        onChange={(next) => update("webRead", { ...props.value.webRead, egressProfileId: next })}
        options={(props.egressProfiles.length === 0 ? [{ value: props.value.webRead.egressProfileId, label: props.value.webRead.egressProfileId }] : props.egressProfiles.map((profile) => ({ value: profile.id, label: profile.label })))}
      /></label>
      <label><span>页面读取超时（毫秒）</span><NumberField aria-label="页面读取超时" min={1000} max={60000} value={props.value.webRead.timeoutMs} onChange={(event) => update("webRead", { ...props.value.webRead, timeoutMs: Number(event.target.value) })} /></label>
      <label><span>最大结果数</span><NumberField aria-label="最大结果数" min={1} max={20} value={props.value.maxResults} onChange={(event) => update("maxResults", Number(event.target.value))} /></label>
      <label><span>正文最大字符数<small>提取后的正文会在此长度处截断。</small></span><NumberField aria-label="正文最大字符数" min={1000} max={100000} value={props.value.maxTextLength} onChange={(event) => update("maxTextLength", Number(event.target.value))} /></label>
      <label><span>最大重定向次数</span><NumberField aria-label="最大重定向次数" min={0} max={10} value={props.value.maxRedirects} onChange={(event) => update("maxRedirects", Number(event.target.value))} /></label>
      <label><span>最大响应大小（MiB）<small>超过上限时会中止页面读取。</small></span><NumberField aria-label="最大响应大小" min={0.0625} max={10} step={0.25} value={props.value.maxResponseBytes / (1024 * 1024)} onChange={(event) => update("maxResponseBytes", Math.round(Number(event.target.value) * 1024 * 1024))} /></label>
      <label><span>仅允许 HTTPS<small>关闭后才允许读取普通 HTTP 公开网页。</small></span><Checkbox aria-label="仅允许 HTTPS" checked={props.value.httpsOnly} onChange={(event) => update("httpsOnly", event.target.checked)} /></label>
      <label><span>域名允许名单<small>每行一个域名；留空允许所有符合安全策略的公开网站。</small></span><Textarea aria-label="域名允许名单" value={props.value.allowedDomains.join("\n")} onChange={(event) => update("allowedDomains", event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))} /></label>
      <label><span>允许 HTML 正文</span><Checkbox aria-label="允许 HTML 正文" checked={props.value.allowedContentTypes.includes("text/html")} onChange={(event) => updateContentType("text/html", event.target.checked)} /></label>
      <label><span>允许纯文本</span><Checkbox aria-label="允许纯文本" checked={props.value.allowedContentTypes.includes("text/plain")} onChange={(event) => updateContentType("text/plain", event.target.checked)} /></label>
    </> : null}
    {props.error ? <p className="configuration-inline-error" role="alert">{props.error}</p> : null}
  </section>;
}

function formatSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1_000;
  return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
}
