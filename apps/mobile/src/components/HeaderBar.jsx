// CrewBus M5 Mobile unified HeaderBar.
import React from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '../theme.js';
import { ROUTES } from '../navigation/routes.js';
import { IconSettings } from './Icons.jsx';

const LOGOS = { light: require('../../assets/header-logo-light.png'), dark: require('../../assets/header-logo-dark.png') };

export function HeaderBar({ title, statusText, connState = 'connected', navigation, rightTitle, onRightPress }) {
  const T = useTheme();
  const dotColor = connState === 'connected' ? T.emerald : (connState === 'probing' ? T.amber : T.rose);
  return (
    <View style={[styles.header, { backgroundColor: T.cardElevated, borderBottomColor: T.border }]}>
      <View style={styles.left}>
        <View style={styles.titleRow}>
          <Image source={LOGOS[T.scheme] || LOGOS.dark} style={styles.logo} resizeMode="contain" />
          <View style={[styles.dot, { backgroundColor: dotColor }]} />
          <Text style={[styles.title, { color: T.text }]}>{title}</Text>
        </View>
        {statusText ? <Text style={[styles.subtitle, { color: T.textMuted }]} numberOfLines={1}>{statusText}</Text> : null}
      </View>
      <View style={styles.right}>
        {rightTitle && onRightPress ? (
          <TouchableOpacity style={[styles.rightBtn, { backgroundColor: T.softFill, borderColor: T.border }]} onPress={onRightPress} activeOpacity={0.7}>
            <Text style={[styles.rightBtnText, { color: T.textMuted }]}>{rightTitle}</Text>
          </TouchableOpacity>
        ) : navigation ? (
          <TouchableOpacity
            style={[styles.rightBtn, { backgroundColor: T.softFill, borderColor: T.border }]}
            onPress={() => navigation.navigate(ROUTES.Settings)}
            activeOpacity={0.7}
          >
            <IconSettings size={15} color={T.textMuted} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    borderBottomWidth: 1,
    paddingTop: 8,
    paddingBottom: 10,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  left: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logo: { height: 22, width: 76 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: { fontSize: 16, fontWeight: '700' },
  subtitle: { fontSize: 11, marginTop: 2 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rightBtn: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rightBtnText: { fontSize: 12, fontWeight: '600' },
});

