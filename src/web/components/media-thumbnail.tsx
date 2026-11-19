import { Film, Images, Music2 } from "lucide-react";
import { useState } from "react";
import type { MediaFile } from "../../shared/media-library-contracts";
import { api } from "../api";
import "./media-thumbnail.css";

const icons = { video: Film, image: Images, audio: Music2 };

/** 图片与视频读取实际缩略图，音频和无封面文件显示类型图标。 */
export function MediaThumbnail({ file, iconSize = 30 }: { file: MediaFile; iconSize?: number }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const Icon = icons[file.category];
  return <span className="media-library-thumbnail">
    {!loaded && <Icon size={iconSize} aria-hidden="true" />}
    {file.category !== "audio" && !failed && <img alt="" loading="lazy"
      src={api.mediaFileUrl(file.libraryId, file.id, "thumbnail")}
      className={loaded ? "is-loaded" : undefined} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
  </span>;
}
