import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useWindowDimensions } from 'react-native'
import { SafeAreaFrameContext, SafeAreaInsetsContext } from 'react-native-safe-area-context'
import type { BridgeRpcClient } from './bridge/bridge-rpc-client'
import { ZERO_SAFE_AREA_INSETS } from './bridge/bridge-safe-area-insets'

/**
 * The page's safe area, as the shell measured it, for every `SafeAreaView` and
 * `useSafeAreaInsets` below. Mounted below ExpoRoot's own `SafeAreaProvider`, whose web half reads
 * `env(safe-area-inset-*)`: 0 in both WebViews, so without this every screen pads by nothing.
 */
export function PageSafeAreaProvider({
  client,
  children
}: {
  client: BridgeRpcClient
  children: ReactNode
}) {
  const insets = useSyncExternalStore(
    client.onSafeAreaInsetsUpdate,
    () => client.getShellSession()?.safeAreaInsets ?? ZERO_SAFE_AREA_INSETS
  )
  const { width, height } = useWindowDimensions()
  const frame = useMemo(() => ({ x: 0, y: 0, width, height }), [width, height])
  return (
    <SafeAreaFrameContext.Provider value={frame}>
      <SafeAreaInsetsContext.Provider value={insets}>{children}</SafeAreaInsetsContext.Provider>
    </SafeAreaFrameContext.Provider>
  )
}
