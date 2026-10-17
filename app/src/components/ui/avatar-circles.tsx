import { host } from "@/lib/sidecar"

interface Avatar {
  imageUrl: string
  profileUrl: string
  label?: string
}
interface AvatarCirclesProps {
  className?: string
  numPeople?: number
  avatarUrls: Avatar[]
}

export const AvatarCircles = ({
  numPeople,
  className,
  avatarUrls,
}: AvatarCirclesProps) => {
  return (
    <div
      className={["avatar-circles [display:flex] [align-items:center] [padding-left:6px]", className].filter(Boolean).join(" ")}
      role="group"
      aria-label="Active chatters"
    >
      {avatarUrls.map((url, index) => (
        <button
          key={index}
          type="button"
          className="avatar-circle [display:grid] [width:28px] [height:28px] [flex:0_0_auto] [place-items:center] [margin-left:-6px] [overflow:hidden] [border:2px_solid_var(--panel)] [border-radius:50%] [background:var(--panel-2)] [padding:0] [cursor:pointer]"
          title={`Open ${url.label || 'chatter'} profile`}
          aria-label={`Open ${url.label || 'chatter'} profile`}
          onClick={() => void host.openStream(url.profileUrl).catch(() => {})}
        >
          <img
            className="avatar-circle-image [width:100%] [height:100%] [object-fit:cover]"
            src={url.imageUrl}
            width={40}
            height={40}
            alt=""
          />
        </button>
      ))}
      {(numPeople ?? 0) > 0 && (
        <span className="avatar-circle-more [display:grid] [width:28px] [height:28px] [flex:0_0_auto] [place-items:center] [margin-left:-6px] [overflow:hidden] [border:2px_solid_var(--panel)] [border-radius:50%] [background:var(--panel-2)] [color:var(--text)] [font-size:9px] [font-weight:700]" aria-label={`${numPeople} more chatters`}>
          +{numPeople}
        </span>
      )}
    </div>
  )
}
