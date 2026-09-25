#!/usr/bin/env python3
"""Render docs/architecture-animated.svg — the README's animated topology.

A vector redraw of docs/architecture.jpg with a looping walk-through: the
login, the read path (inspect:read) and the privileged path (ops:write,
acr=mfa). Each namespace's JWT-SVID drops from SPIRE as the packet reaches it,
and each agent/MCP hop drops to Curity for its RFC 8693 exchange. The SVG must work inside a GitHub README, i.e. through <img>: no
script, no external fonts or images — motion is SMIL only, and every animated
element shares one clock (dur=T, repeatCount=indefinite) with keyTimes
selecting its window. prefers-reduced-motion hides the motion layer.

    python3 scripts/render-architecture-svg.py   # writes docs/architecture-animated.svg
"""
import math
import pathlib
import re

OUT = pathlib.Path(__file__).resolve().parent.parent / "docs" / "architecture-animated.svg"

W, H = 2000, 1090
SPEED = 480.0  # packet speed, viewBox units per second
SLOW = 0.65  # speed factor from the agents box on, where there is more to read

BG = "#0d1117"
FG = "#e6edf3"
MUTED = "#8b949e"
BOX = "#c9d1d9"
# Tier colours match the landing page hero (apps/web/src/components/hero-stage.tsx):
# lilac = read, amber = privileged. Colour-blind safe, unlike red/green.
READ = "#caa8ff"  # hsl(263 100% 83%)
PRIV = "#f59d38"  # hsl(32 90% 59%)
BLUE = "#58a6ff"
POD = "#326ce5"
PINK = "#e0569b"
WHITE = "#ffffff"

MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

# --- geometry ---------------------------------------------------------------

NODES = {
    "browser": (90, 492),
    "edge": (423, 482),
    "web": (593, 482),
    "copilot": (866, 365),
    "specialist": (866, 640),
    "llmgw": (992, 498),
    "llm": (1062, 498),
    "gw": (1166, 497),
    "mi": (1280, 350),
    "mo": (1280, 625),
    "wp": (1495, 487),
    "ia": (1602, 350),
    "oa": (1602, 615),
    "checkout": (1865, 443),
    "order": (1865, 540),
}
R = {"pod": 27, "gw": 22, "small": 18}

CURITY = (493, 894, 1234, 60)
SPIRE = (500, 78, 1235, 60)
# namespace boxes: name -> (x, y, w, h)
NS = {
    "istio-ingress": (352, 357, 142, 280),
    "web": (548, 325, 90, 345),
    "agents": (788, 265, 156, 500),
    "mcp": (1111, 256, 234, 496),
    "apis": (1440, 261, 224, 475),
    "prod": (1820, 366, 90, 242),
}
# SVID drops from SPIRE: namespace -> (x, the namespace top it lands on)
SVID_DROPS = {"web": (593, 325), "agents": (866, 265), "mcp": (1228, 256), "apis": (1552, 261)}
# exchange lines to Curity: (x, top_y, colour)
EXCH = {
    "agents-read": (825, 765, READ),
    "agents-priv": (905, 765, PRIV),
    "mcp-read": (1150, 752, READ),
    "mcp-priv": (1302, 752, PRIV),
}


def trim(a, b, ra, rb):
    """Segment a→b shortened by ra at a and rb at b."""
    (x1, y1), (x2, y2) = a, b
    d = math.hypot(x2 - x1, y2 - y1)
    ux, uy = (x2 - x1) / d, (y2 - y1) / d
    return (x1 + ux * ra, y1 + uy * ra), (x2 - ux * rb, y2 - uy * rb)


def shift(seg, d):
    """Offset a segment perpendicular to itself (for parallel red/green lines)."""
    (x1, y1), (x2, y2) = seg
    l = math.hypot(x2 - x1, y2 - y1)
    nx, ny = -(y2 - y1) / l * d, (x2 - x1) / l * d
    return (x1 + nx, y1 + ny), (x2 + nx, y2 + ny)


def plen(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def pstr(pts):
    return "M" + " L".join(f"{x:.1f},{y:.1f}" for x, y in pts)


N = NODES
PROD_IN_TOP, PROD_IN_BOT = (1820, 428), (1820, 552)

# The LLM hops are elbows (down/up, then across) so neither crosses a data line.
LLM_IN = N["llmgw"][0] - R["gw"] - 3
ELBOW = {
    "copilot-llm": [(884, 386), (884, N["llmgw"][1] - 7), (LLM_IN, N["llmgw"][1] - 7)],
    "specialist-llm": [(884, 619), (884, N["llmgw"][1] + 7), (LLM_IN, N["llmgw"][1] + 7)],
}

# Data-plane segments. Shared hops carry both tiers, drawn as parallel lines.
SEG = {
    "code": ((155, 482), (N["edge"][0] - R["pod"] - 4, 482)),
    "edge-web": trim(N["edge"], N["web"], R["pod"], R["pod"]),
    "web-agents": ((622, 482), (786, 482)),
    "copilot-gw": trim(N["copilot"], N["gw"], R["pod"] + 4, R["gw"] + 6),
    "a2a": trim(N["copilot"], N["specialist"], R["pod"] + 4, R["pod"] + 4),
    "specialist-gw": trim(N["specialist"], N["gw"], R["pod"] + 4, R["gw"] + 6),
    "llmgw-llm": trim(N["llmgw"], N["llm"], R["gw"] + 2, 28),
    "gw-mo": trim(N["gw"], N["mo"], R["gw"] + 4, R["pod"] + 4),
    "mo-wp": trim(N["mo"], N["wp"], R["pod"] + 4, R["gw"] + 6),
    "wp-oa": trim(N["wp"], N["oa"], R["gw"] + 4, R["pod"] + 4),
    "oa-prod": trim(N["oa"], PROD_IN_BOT, R["pod"] + 4, 4),
}
for key, a, b, ra, rb in [
    ("gw-mi", N["gw"], N["mi"], R["gw"] + 4, R["pod"] + 4),
    ("mi-wp", N["mi"], N["wp"], R["pod"] + 4, R["gw"] + 6),
    ("wp-ia", N["wp"], N["ia"], R["gw"] + 4, R["pod"] + 4),
    ("ia-prod", N["ia"], PROD_IN_TOP, R["pod"] + 4, 4),
]:
    base = trim(a, b, ra, rb)
    SEG[key + ":r"] = shift(base, -6)
    SEG[key + ":g"] = shift(base, 6)

# --- svg helpers ------------------------------------------------------------

out = []


def e(s):
    out.append(s)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def text(x, y, s, size=15, fill=FG, anchor="middle", font=MONO, weight=None, extra=""):
    w = f' font-weight="{weight}"' if weight else ""
    e(
        f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" '
        f'text-anchor="{anchor}" font-family="{font}"{w} {extra}>{esc(s)}</text>'
    )


def seg_label(seg, s, off, size=14, fill=FG):
    """Text centred on a segment, rotated with it, offset perpendicular."""
    (x1, y1), (x2, y2) = seg
    ang = math.degrees(math.atan2(y2 - y1, x2 - x1))
    if ang > 90 or ang < -90:
        ang += 180
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    r = math.radians(ang)
    mx, my = mx + math.sin(r) * off, my - math.cos(r) * off
    text(mx, my, s, size, fill, extra=f'transform="rotate({ang:.1f} {mx:.1f} {my:.1f})"')


def line(seg, color, width=2.2, marker=None, dash=None, opacity=1):
    (x1, y1), (x2, y2) = seg
    m = f' marker-end="url(#arrow-{marker})"' if marker else ""
    d = f' stroke-dasharray="{dash}"' if dash else ""
    e(
        f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{color}" '
        f'stroke-width="{width}" stroke-opacity="{opacity}" stroke-linecap="round"{d}{m}/>'
    )


def polyline(pts, color, width=2.2, marker=None, dash=None, opacity=1):
    m = f' marker-end="url(#arrow-{marker})"' if marker else ""
    d = f' stroke-dasharray="{dash}"' if dash else ""
    e(
        f'<path d="{pstr(pts)}" fill="none" stroke="{color}" stroke-width="{width}" '
        f'stroke-opacity="{opacity}" stroke-linecap="round" stroke-linejoin="round"{d}{m}/>'
    )


def ns_box(name, x, y, w, h):
    e(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="#ffffff" fill-opacity="0.02" stroke="{BOX}" stroke-opacity="0.75" stroke-width="1.6"/>')
    cx = x + w / 2
    text(cx, y + 26, name, 16, FG, weight="600")
    tw = len(name) * 9.6
    line(((cx - tw / 2, y + 34), (cx + tw / 2, y + 34)), BOX, 1.2, opacity=0.6)


def pod(key, label, label_fill=FG, sub=None, r=R["pod"], label_dy=None, above=False):
    x, y = N[key]
    pts = " ".join(
        f"{x + r * math.cos(math.radians(90 + 360 / 7 * i)):.1f},{y - r * math.sin(math.radians(90 + 360 / 7 * i)):.1f}"
        for i in range(7)
    )
    e(f'<polygon points="{pts}" fill="{POD}" stroke="#ffffff" stroke-opacity="0.85" stroke-width="1.5" stroke-linejoin="round"/>')
    # isometric cube glyph, the Kubernetes "pod" icon
    s = r * 0.42
    cube = [
        f"M{x:.1f},{y - s:.1f} L{x + s * 0.87:.1f},{y - s / 2:.1f} L{x:.1f},{y:.1f} L{x - s * 0.87:.1f},{y - s / 2:.1f} Z",
        f"M{x - s * 0.87:.1f},{y - s / 2:.1f} L{x - s * 0.87:.1f},{y + s / 2:.1f} L{x:.1f},{y + s:.1f} L{x:.1f},{y:.1f}",
        f"M{x + s * 0.87:.1f},{y - s / 2:.1f} L{x + s * 0.87:.1f},{y + s / 2:.1f} L{x:.1f},{y + s:.1f}",
    ]
    for d in cube:
        e(f'<path d="{d}" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>')
    ly = y + (label_dy if label_dy is not None else (-r - 12 if above else r + 21))
    text(x, ly, label, 15 if r >= R["pod"] else 13, label_fill)
    if sub:
        text(x, ly + 17, sub, 12, MUTED)


def gateway(key, label, sub=None):
    x, y = N[key]
    s = R["gw"]
    e(f'<rect x="{x - s}" y="{y - s}" width="{2 * s}" height="{2 * s}" rx="6" fill="{BG}" stroke="#ffffff" stroke-width="1.8"/>')
    e(f'<circle cx="{x}" cy="{y}" r="{s * 0.6:.1f}" fill="none" stroke="#ffffff" stroke-width="1.6"/>')
    for i in range(6):
        a = math.radians(60 * i)
        e(
            f'<line x1="{x + math.cos(a) * s * 0.18:.1f}" y1="{y + math.sin(a) * s * 0.18:.1f}" '
            f'x2="{x + math.cos(a) * s * 0.85:.1f}" y2="{y + math.sin(a) * s * 0.85:.1f}" stroke="#ffffff" stroke-width="1.4"/>'
        )
    text(x, y + s + 20, label, 13, FG)
    if sub:
        text(x, y + s + 36, sub, 12, MUTED)


def ticket(x, y, color, scale=1.0):
    e(
        f'<g transform="translate({x} {y}) rotate(-35) scale({scale})"><rect x="-13" y="-8" width="26" height="16" rx="3" '
        f'fill="none" stroke="{color}" stroke-width="1.8"/><circle cx="-6" cy="0" r="2.2" fill="{color}"/></g>'
    )


CURITY_MARK = (
    "m53.06 26.79-.56.57a15.93 15.93 0 0 1-10.93 5 10 10 0 0 1-10.34-10.4c0-6 4.24-10.39 "
    "10.09-10.39a16.67 16.67 0 0 1 10.22 4l.56.49 5.61-5.86-.63-.54a25.78 25.78 0 0 0-16.36-5.91 "
    "18.44 18.44 0 0 0-15.37 7.68H15l-.6 5.09h8.5a17.9 17.9 0 0 0-.59 2.86H9.61L9 24.46h13.31a18.56 "
    "18.56 0 0 0 .57 2.86H3.77l-.61 5.09H25.3c3.29 4.74 8.9 7.68 15.67 7.68a25.41 25.41 0 0 0 "
    "17.19-6.93l.59-.56Z"
)

# --- timeline ---------------------------------------------------------------

anim = []  # SMIL-animated elements, appended in timeline order
captions = []  # (t0, t1, text)
t = 0.4
speed = 1.0  # current factor on SPEED; drops to SLOW once the packet reaches the agents
T = None  # set once the timeline is laid out


def kt(*times):
    """keyTimes string from absolute seconds, clamped monotonic in [0, 1]."""
    ks, last = [], 0.0
    for x in times:
        v = min(max(x / T, last), 1.0)
        ks.append(v)
        last = v
    ks[0], ks[-1] = 0.0, 1.0
    return ";".join(f"{v:.4f}" for v in ks)


def vis(t0, t1, peak=1.0, fade=0.3, attr="opacity"):
    return (
        f'<animate attributeName="{attr}" dur="{{T}}s" repeatCount="indefinite" '
        f'values="0;0;{peak};{peak};0;0" keyTimes="{{kt:0,{t0 - fade},{t0},{t1},{t1 + fade},END}}"/>'
    )


def render_deferred(tpl):
    """Resolve the {T} and {kt:a,b,...,END} placeholders once T is known."""
    s = re.sub(
        r"\{kt:([^}]*)\}",
        lambda m: kt(*(T if v == "END" else float(v) for v in m.group(1).split(","))),
        tpl,
    )
    return s.replace("{T}", f"{T:.2f}")


def packet(pts, color, t0, t1, r=7):
    path = pstr(pts)
    anim.append(
        f'<g opacity="0">{vis(t0, t1, fade=0.15)}'
        f'<circle r="{r * 2.2:.1f}" fill="{color}" fill-opacity="0.45" filter="url(#glow)"/>'
        f'<circle r="{r}" fill="{color}"/><circle r="{r * 0.4:.1f}" fill="#ffffff" fill-opacity="0.8"/>'
        f'<animateMotion dur="{{T}}s" repeatCount="indefinite" calcMode="linear" '
        f'keyPoints="0;0;1;1" keyTimes="{{kt:0,{t0},{t1},END}}" path="{path}"/></g>'
    )


def trail(pts, color, t0, t1, width=5):
    anim.append(
        f'<path d="{pstr(pts)}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" '
        f'filter="url(#soft)" opacity="0">{vis(t0, t1, peak=0.9, fade=0.4)}</path>'
    )


def ring(key, color, t0, t1, r=36):
    x, y = N[key]
    anim.append(
        f'<circle cx="{x}" cy="{y}" r="{r}" fill="{color}" fill-opacity="0.16" stroke="{color}" '
        f'stroke-width="2.5" opacity="0">{vis(t0, t1, fade=0.25)}</circle>'
    )


def glow_rect(rect, color, t0, t1, rx=12):
    x, y, w, h = rect
    anim.append(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{color}" fill-opacity="0.18" '
        f'stroke="{color}" stroke-width="3" opacity="0">{vis(t0, t1, fade=0.25)}</rect>'
    )


def badge(x, y, s, color, t0, t1):
    w = len(s) * 8.6 + 20
    anim.append(
        f'<g opacity="0">{vis(t0, t1)}<rect x="{x - w / 2:.1f}" y="{y - 13}" width="{w:.1f}" height="24" rx="12" '
        f'fill="{BG}" stroke="{color}" stroke-width="1.6"/><text x="{x}" y="{y + 4}" font-size="13" '
        f'fill="{color}" text-anchor="middle" font-family="{MONO}">{esc(s)}</text></g>'
    )


def move(pts, color, wait=0.0):
    """Walk a packet along pts; its trail stays lit until the beat ends."""
    global t
    t0 = t
    t1 = t0 + plen(pts) / (SPEED * speed)
    packet(pts, color, t0, t1)
    pending.append((pts, color, t0))
    t = t1 + wait
    return t0, t1


def exchange(key, node, color):
    """RFC 8693 at Curity: two tokens go down, one narrowed token comes back.

    Down go the subject token (the tier colour) and the workload's own
    JWT-SVID as actor_token (SVID blue), side by side, since they are two
    separate credentials. Back up comes the single exchanged token.
    """
    global t
    x, top, _ = EXCH[key]
    bottom = CURITY[1]
    t0 = t
    tm = t0 + (bottom - top) / (SPEED * speed * 0.9)  # at Curity
    t1 = tm + (bottom - top) / (SPEED * speed * 0.9)  # back
    ring(node, color, t0, t1 + 0.2)
    packet([(x - 7, top), (x - 7, bottom)], color, t0, tm, r=6)  # subject_token
    packet([(x + 7, top), (x + 7, bottom)], BLUE, t0, tm, r=6)  # actor_token (JWT-SVID)
    packet([(x, bottom), (x, top)], color, tm, t1, r=6)  # the narrowed token
    trail([(x, top), (x, bottom)], color, t0, t1 + 0.1, width=4)
    glow_rect(CURITY, PINK, tm - 0.15, tm + 0.15)
    t = t1 + 0.1
    return t0, t1


def svid(ns, arrive):
    """The namespace's JWT-SVID drops from SPIRE, landing as the packet arrives."""
    x, top = SVID_DROPS[ns]
    pts = [(x, SPIRE[1] + SPIRE[3]), (x, top)]
    t0 = arrive - plen(pts) / (SPEED * 0.4)
    packet(pts, BLUE, t0, arrive, r=5)
    trail(pts, BLUE, t0, arrive + 0.3, width=3)
    glow_rect((x + 12, 164, 36, 32), BLUE, t0, arrive + 0.3, rx=8)  # its ticket
    glow_rect(SPIRE, BLUE, t0 - 0.1, t0 + 0.25)


pending = []  # trails waiting for their beat to end


def end_beat(caption, start):
    global t
    for pts, color, t0 in pending:
        trail(pts, color, t0, t + 0.6)
    pending.clear()
    captions.append((start, t + 0.6, caption))
    t += 1.1


# Beat 1 — login: code flow + PKCE, Curity issues the user token.
b = t
move([*SEG["code"], N["edge"]], WHITE)
svid("web", move([N["edge"], N["web"]], WHITE)[1])
t0 = t
move([N["web"], (N["web"][0], CURITY[1]), N["web"]], WHITE)
glow_rect(CURITY, PINK, t0 + 0.45, t0 + 1.0)
badge(N["web"][0], 612, "user token", WHITE, t - 0.2, t + 1.8)
speed = SLOW
svid("agents", move([N["web"], *SEG["web-agents"], (812, 482), (812, 365), (N["copilot"][0] - R["pod"], 365)], WHITE)[1])
ring("copilot", WHITE, t - 0.1, t + 0.5)
t += 0.4
end_beat("① alice signs in with OIDC + PKCE; Curity issues the user token (aud=agent-copilot)", b)

# Beat 2 — read path.
b = t
exchange("agents-read", "copilot", READ)
badge(N["copilot"][0], 425, "inspect:read", READ, t - 0.4, t + 1.6)
move(ELBOW["copilot-llm"], READ, wait=0.15)
ring("llmgw", READ, t - 0.2, t + 0.3)
t += 0.3
svid("mcp", move([N["copilot"], *SEG["copilot-gw"], N["gw"]], READ)[1])
exchange("mcp-read", "gw", READ)
move([N["gw"], *SEG["gw-mi:r"], N["mi"]], READ)
svid("apis", move([N["mi"], *SEG["mi-wp:r"], N["wp"]], READ)[1])
move([N["wp"], *SEG["wp-ia:r"], N["ia"]], READ)
move([N["ia"], *SEG["ia-prod:r"]], READ)
ring("checkout", READ, t - 0.1, t + 0.7, r=26)
ring("order", READ, t - 0.1, t + 0.7, r=26)
t += 0.5
end_beat("② read path: each hop proves itself with its JWT-SVID and swaps its token at Curity (RFC 8693), narrowed to inspect:read", b)

# Beat 3 — privileged path.
b = t
svid("agents", move([N["copilot"], *SEG["a2a"], N["specialist"]], PRIV)[1])
exchange("agents-priv", "specialist", PRIV)
badge(N["specialist"][0], 728, "ops:write · acr=mfa", PRIV, t - 0.4, t + 1.8)
svid("mcp", move([N["specialist"], *SEG["specialist-gw"], N["gw"]], PRIV)[1])
exchange("mcp-priv", "gw", PRIV)
move([N["gw"], *SEG["gw-mo"], N["mo"]], PRIV)
svid("apis", move([N["mo"], *SEG["mo-wp"], N["wp"]], PRIV)[1])
move([N["wp"], *SEG["wp-oa"], N["oa"]], PRIV)
move([N["oa"], *SEG["oa-prod"]], PRIV)
ring("checkout", PRIV, t - 0.1, t + 0.7, r=26)
ring("order", PRIV, t - 0.1, t + 0.7, r=26)
t += 0.5
end_beat("③ privileged path: A2A to the specialist, which needs ops:write and an MFA step-up (acr=mfa)", b)

T = t + 0.4

# --- document ---------------------------------------------------------------

e(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">')
e("<title id=\"t\">AI agent authentication and authorization: architecture</title>")
e(
    '<desc id="d">Browser to istio-ingress to the web BFF to agent-copilot. The read path (lilac) goes through the MCP '
    "gateway to mcp-inspect, the Istio waypoint and inspect-api, which lists pods and logs in prod. The privileged path "
    "(amber) goes over A2A to agent-specialist, then through the MCP gateway to mcp-ops and ops-api, which patches "
    "deployments in prod. SPIRE issues each workload a JWT-SVID. At every agent and MCP hop the workload exchanges its "
    "token at Curity (RFC 8693).</desc>"
)
e("<defs>")
for name, color in [("read", READ), ("priv", PRIV), ("white", "#d0d7de"), ("blue", BLUE)]:
    e(
        f'<marker id="arrow-{name}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="{color}"/></marker>'
    )
e('<filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5"/></filter>')
e('<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>')
e(
    "<style>.static{display:none}"
    "@media (prefers-reduced-motion: reduce){#motion,#captions{display:none}.static{display:inline}}</style>"
)
e("</defs>")
e(f'<rect width="{W}" height="{H}" rx="18" fill="{BG}"/>')

# cluster + planes
e(f'<rect x="195" y="22" width="1750" height="982" rx="22" fill="none" stroke="{BOX}" stroke-opacity="0.85" stroke-width="2"/>')
cx, cy = 223, 50  # kubernetes wheel
e(f'<circle cx="{cx}" cy="{cy}" r="19" fill="{POD}"/><circle cx="{cx}" cy="{cy}" r="10" fill="none" stroke="#fff" stroke-width="2"/>')
for i in range(7):
    a = math.radians(-90 + 360 / 7 * i)
    e(f'<line x1="{cx}" y1="{cy}" x2="{cx + math.cos(a) * 15:.1f}" y2="{cy + math.sin(a) * 15:.1f}" stroke="#fff" stroke-width="2" stroke-linecap="round"/>')
text(210, 92, "k8s cluster (KIND)", 15, FG, anchor="start")

x, y, w, h = SPIRE
e(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{BLUE}" fill-opacity="0.06" stroke="{BOX}" stroke-width="1.6"/>')
text(x + 12, y + 22, "spire", 15, FG, anchor="start", weight="600")
sx = x + w / 2 - 150
for i, dx in enumerate((-9, 0, 9)):
    e(f'<path d="M{sx + dx:.1f},{y + 44} L{sx + dx:.1f},{y + 24 - (6 if dx == 0 else 0)}" stroke="#3ec5c5" stroke-width="3" stroke-linecap="round"/>')
e(f'<path d="M{sx - 14},{y + 30} L{sx},{y + 16} L{sx + 14},{y + 30}" fill="none" stroke="#3ec5c5" stroke-width="2.5"/>')
text(sx + 26, y + 36, "SPIFFE / SPIRE", 17, FG, anchor="start", weight="600")
text(sx + 190, y + 36, "workload identity · JWT-SVIDs", 13, MUTED, anchor="start")

e(f'<rect x="487" y="227" width="1252" height="623" rx="16" fill="none" stroke="{BOX}" stroke-opacity="0.55" stroke-width="1.5" stroke-dasharray="3 6"/>')
e(f'<circle cx="512" cy="252" r="15" fill="#ffffff"/><path d="M506,260 L512,241 L512,260 Z M514,244 L520,260 L514,260 Z" fill="#466bb0"/>')
text(535, 257, "istio ambient mesh", 14, MUTED, anchor="start")

x, y, w, h = CURITY
e(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{PINK}" fill-opacity="0.07" stroke="{BOX}" stroke-width="1.6"/>')
text(x + 12, y + 22, "curity", 15, FG, anchor="start", weight="600")
mx = x + w / 2 - 250
e(f'<svg x="{mx}" y="{y + 16}" width="44" height="28.5" viewBox="0 0 56 36.33"><g transform="translate(-3.16 -3.75)"><path fill="{PINK}" d="{CURITY_MARK}"/></g><path fill="{PINK}" d="M5.01 15.62H1.26l-.6 5.09H4.4l.61-5.09z"/></svg>')
text(mx + 56, y + 38, "CURITY", 18, FG, anchor="start", font=SANS, weight="700", extra='letter-spacing="3"')
text(mx + 150, y + 38, "sole token issuer · RFC 8693 token exchange at every hop", 13, MUTED, anchor="start")

# SVID drops
for x, top in SVID_DROPS.values():
    line(((x, SPIRE[1] + SPIRE[3]), (x, top)), BLUE, 1.4, dash="2 5", opacity=0.7)
    ticket(x + 30, 180, BLUE)
    text(x + 12, 214, "JWT-SVID", 13, BLUE, anchor="start")

# exchange lines
for key, (x, top, color) in EXCH.items():
    line(((x, top), (x, CURITY[1])), color, 1.8, dash="8 7", opacity=0.8)
for cx_ in (865, 1226):
    # the exchange's two inputs: the Curity-issued access token and the JWT-SVID
    ticket(cx_ - 12, 790, PINK)
    ticket(cx_ + 6, 784, BLUE)
    e(f'<rect x="{cx_ - 128}" y="811" width="256" height="24" rx="4" fill="{BG}"/>')
    text(cx_, 828, "RFC 8693 token exchange (OBO)", 14, FG)

# browser
e(f'<rect x="25" y="370" width="130" height="280" rx="14" fill="none" stroke="{BOX}" stroke-width="1.6"/>')
text(90, 398, "Browser", 16, FG, weight="600")
e(f'<rect x="62" y="420" width="56" height="36" rx="4" fill="none" stroke="#fff" stroke-width="1.6"/><line x1="62" y1="429" x2="118" y2="429" stroke="#fff" stroke-width="1.4"/>')
e(f'<circle cx="90" cy="444" r="8" fill="{BLUE}"/>')
e(f'<circle cx="90" cy="490" r="12" fill="none" stroke="#fff" stroke-width="2"/><path d="M68,535 Q90,500 112,535" fill="none" stroke="#fff" stroke-width="2"/>')
text(90, 565, "alice · bob", 13, FG)
text(90, 583, "carol", 13, FG)

# namespaces
for name, (x, y, w, h) in NS.items():
    ns_box(name, x, y, w, h)

# data plane — static lines
line(SEG["code"], "#d0d7de", 2.4, marker="white")
text(262, 468, "code flow", 18, FG, font=SANS)
line(SEG["edge-web"], "#d0d7de", 2, marker="white")
line(SEG["web-agents"], "#d0d7de", 2, marker="white")
text(712, 468, "user access token", 13, FG)
text(712, 504, "aud=agent-copilot", 13, MUTED)
line(((593, 670), (593, CURITY[1] - 4)), "#d0d7de", 1.8, marker="white")
text(605, 745, "OIDC + PKCE", 14, FG, anchor="start")

line(SEG["copilot-gw"], READ, 2.6, marker="read")
seg_label(SEG["copilot-gw"], "MCP · inspect:read (OBO)", 12, 14, READ)
seg_label(SEG["copilot-gw"], "tool call", -20, 13, READ)
line(SEG["a2a"], PRIV, 2.6, marker="priv")
for i, s in enumerate(("A2A", "(OBO", "token)")):
    text(856, 500 + i * 17, s, 13, PRIV, anchor="end")
line(SEG["specialist-gw"], PRIV, 2.6, marker="priv")
seg_label(SEG["specialist-gw"], "MCP · ops:write (OBO)", -30, 14, PRIV)
seg_label(SEG["specialist-gw"], "tool call", -50, 13, PRIV)
polyline(ELBOW["copilot-llm"], READ, 1.6, dash="3 5", marker="read", opacity=0.8)
polyline(ELBOW["specialist-llm"], PRIV, 1.6, dash="3 5", marker="priv", opacity=0.8)
line(SEG["llmgw-llm"], "#d0d7de", 1.6, dash="3 4", opacity=0.8)

for k in ("gw-mi", "mi-wp", "wp-ia", "ia-prod"):
    line(SEG[k + ":r"], READ, 2.4, marker="read")
    line(SEG[k + ":g"], PRIV, 2.4, marker="priv")
for k in ("gw-mo", "mo-wp", "wp-oa", "oa-prod"):
    line(SEG[k], PRIV, 2.4, marker="priv")
seg_label(SEG["mi-wp:r"], "inspect (OBO)", 14, 13, READ)
seg_label(SEG["mo-wp"], "ops (OBO)", 12, 13, PRIV)
seg_label(SEG["ia-prod:r"], "list, logs (RBAC)", 14, 13, READ)
seg_label(SEG["oa-prod"], "patch (RBAC)", 12, 13, PRIV)

# nodes
pod("edge", "istio-edge-gw", r=22, label_dy=42)
pod("web", "web", sub="Next.js BFF", r=24, label_dy=44)
pod("copilot", "agent-copilot", READ, above=True)
pod("specialist", "agent-specialist", PRIV)
gateway("llmgw", "LLM gateway")
x, y = N["llm"]
e(f'<rect x="{x - 26}" y="{y - 30}" width="52" height="60" rx="8" fill="#ffffff" fill-opacity="0.04" stroke="{MUTED}" stroke-width="1.8" stroke-dasharray="5 3"/>')
text(x, y - 2, "LLM", 14, FG, weight="700")
text(x, y + 16, "vendor", 11, MUTED)
gateway("gw", "MCP gateway", "agentgateway")
pod("mi", "mcp-inspect", READ, above=True)
pod("mo", "mcp-ops", PRIV)
gateway("wp", "waypoint", "L7 authz")
pod("ia", "inspect-api", READ, above=True)
pod("oa", "ops-api", PRIV)
pod("checkout", "check-out", r=R["small"], label_dy=32)
pod("order", "order", r=R["small"], label_dy=32)

# legend: the two paths, then the two kinds of token (the exchange explains itself)
lx, ly = 1752, 910
for i, (label, color) in enumerate([("read path", READ), ("privileged path", PRIV)]):
    yy = ly + i * 22
    line(((lx, yy), (lx + 34, yy)), color, 2.4)
    text(lx + 44, yy + 5, label, 13, color, anchor="start")
for i, (label, color) in enumerate([("access token", PINK), ("JWT-SVID", BLUE)]):
    yy = ly + (i + 2) * 22
    ticket(lx + 17, yy, color, scale=0.62)
    text(lx + 44, yy + 5, label, 13, color, anchor="start")

# motion layer
e('<g id="motion">')
for a in anim:
    e(render_deferred(a))
e("</g>")

# captions, below the cluster
e('<g id="captions">')
for t0, t1, s in captions:
    e(
        render_deferred(
            f'<text x="200" y="1050" font-size="21" fill="{FG}" font-family="{SANS}" opacity="0">{esc(s)}'
            f"{vis(t0, t1, fade=0.35)}</text>"
        )
    )
e("</g>")
text(200, 1050, "read path (lilac): inspect:read  ·  privileged path (amber): ops:write + acr=mfa step-up", 21, FG, anchor="start", font=SANS, extra='class="static"')

e("</svg>")
OUT.write_text("\n".join(out) + "\n")
print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.1f} KiB, loop {T:.1f}s)")
