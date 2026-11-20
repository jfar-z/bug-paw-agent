import { ArrowRight } from "lucide-react";
import { configurationCapabilities } from "../configuration-navigation";
import type { AppRoute } from "../router";
import "../configuration.css";

/** 以配置目录顺序呈现能力入口，导航到对应配置页。 */
export function CapabilitiesPage({ onNavigate }: { onNavigate: (route: AppRoute) => void }) {
  return <div className="configuration-page">
    <header className="configuration-page__heading">
      <span className="configuration-eyebrow">CAPABILITIES</span>
      <h1>能力扩展</h1>
      <p>集中配置联网搜索、浏览器执行、AIGC、语音和知识能力。</p>
    </header>
    <section className="configuration-section" aria-labelledby="capability-list-title">
      <div className="configuration-section__heading"><div><h2 id="capability-list-title">已接入能力</h2></div></div>
      <div className="configuration-entry-list">
        {configurationCapabilities.map(({ key, title, description, route, icon: Icon }) => (
          <button key={key} type="button" className="configuration-entry" onClick={() => onNavigate(route)}>
            <Icon size={18} aria-hidden="true" />
            <span><strong>{title}</strong><small>{description}</small></span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  </div>;
}
