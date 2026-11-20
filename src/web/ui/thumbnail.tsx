import {useState,type ReactNode} from "react";
import "./thumbnail.css";

/** 切换资源时重新进入加载态，解码失败后保留类型图标。 */
export function Thumbnail({src,alt="",fallback,className=""}:{src?:string;alt?:string;fallback:ReactNode;className?:string}){
  return <ThumbnailImage key={src} src={src} alt={alt} fallback={fallback} className={className}/>;
}
function ThumbnailImage({src,alt,fallback,className}:{src?:string;alt:string;fallback:ReactNode;className:string}){
  const [state,setState]=useState<"loading"|"loaded"|"failed">("loading");
  return <span className={"bp-thumbnail "+className}>{state!=="loaded"&&fallback}
    {src&&state!=="failed"&&<img alt={alt} loading="lazy" src={src} className={state==="loaded"?"is-loaded":undefined} onLoad={()=>setState("loaded")} onError={()=>setState("failed")}/>}</span>;
}
