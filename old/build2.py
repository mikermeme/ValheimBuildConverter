#!/usr/bin/env python3
"""Assemble converter-v2.html: shell + codecs.js + codecs-ext.js + app.js, one file."""
import sys

shell = open('app-shell.html', encoding='utf-8').read()
codecs = open('codecs.js', encoding='utf-8').read()
ext = open('codecs-ext.js', encoding='utf-8').read()
app = open('app.js', encoding='utf-8').read()

for anchor in ('<!--CODECS-->', '<!--APP-->'):
    if shell.count(anchor) != 1:
        sys.exit(f'anchor {anchor} not unique')

# codecs + extensions share one IIFE scope (ext references codec-internal globals);
# BFC is exported on window at the end of codecs.js, extensions attach to it.
codec_block = '<script>\n(function () {\n' + codecs + '\n' + ext + '\n})();\n</script>'
app_block = '<script>\n' + app + '\n</script>'

out = shell.replace('<!--CODECS-->', codec_block).replace('<!--APP-->', app_block)
open('converter-v2.html', 'w', encoding='utf-8', newline='\n').write(out)
print(f'converter-v2.html written: {len(out):,} bytes')
