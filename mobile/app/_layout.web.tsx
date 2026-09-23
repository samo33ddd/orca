import { StyleSheet, View } from 'react-native'
import { Slot } from 'expo-router'
import { PageSafeAreaProvider } from '../src/mobile-web-shell/page-safe-area-provider'
import { usePageBridgeClient } from '../src/transport/client-context.web'
import { colors } from '../src/theme/mobile-theme'

/**
 * The page's root layout, standing where the native `_layout.tsx` does. Without one expo-router
 * mounts `DefaultNavigator`, an all-edges `SafeAreaView`, so the page would pad once there and again
 * in each screen's own `SafeAreaView`. Like the native root it adds no padding: screens pad once.
 */
export default function PageRootLayout() {
  return (
    <PageSafeAreaProvider client={usePageBridgeClient()}>
      <View style={styles.root}>
        <Slot />
      </View>
    </PageSafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
