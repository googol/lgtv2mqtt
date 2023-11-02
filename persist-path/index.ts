import path from 'node:path'

export function persistPath(
  pathKind: PathKind,
  ...args: readonly string[]
): string {
  const xdgPath = getXdgPath(pathKind)

  return path.join(xdgPath, ...args)
}

function getXdgPath(pathKind: PathKind): string {
  const { envVar, defaultInHome } = pathKindConfig[pathKind]

  const xdgPathCandidate = process.env[envVar]

  if (isValidXdgPath(xdgPathCandidate)) {
    return xdgPathCandidate
  }

  const home = process.env.HOME
  if (isValidXdgPath(home)) {
    return path.join(home, defaultInHome)
  }

  throw new Error('Unable to find xdg path')
}

const pathKindConfig = {
  config: {
    envVar: 'XDG_CONFIG_HOME',
    defaultInHome: '.config',
  },
  data: {
    envVar: 'XDG_DATA_HOME',
    defaultInHome: '.local/share',
  },
  state: {
    envVar: 'XDG_STATE_HOME',
    defaultInHome: '.local/state',
  },
}

type PathKind = keyof typeof pathKindConfig

function isValidXdgPath(
  xdgPathCandidate: string | undefined,
): xdgPathCandidate is string {
  return (
    xdgPathCandidate !== undefined &&
    xdgPathCandidate.trim() !== '' &&
    path.isAbsolute(xdgPathCandidate)
  )
}
