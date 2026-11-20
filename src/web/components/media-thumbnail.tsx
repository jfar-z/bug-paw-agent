import { Film, Images, Music2 } from "lucide-react";
import { Thumbnail } from "../ui/thumbnail";
import type { MediaFile } from "../../shared/media-library-contracts";
import { api } from "../api";


const icons = { video: Film, image: Images, audio: Music2 };

/** 图片与视频读取实际缩略图，音频和无封面文件显示类型图标。 */
export function MediaThumbnail({ file, iconSize = 30 }: { file: MediaFile; iconSize?: number }) {
  const Icon = icons[file.category];
  return <Thumbnail className="media-library-thumbnail" src={file.category==="audio"?undefined:api.mediaFileUrl(file.libraryId,file.id,"thumbnail")} fallback={<Icon size={iconSize} aria-hidden/>}/>;
}
