"""Build the Keiser M3 Bridge product page.

Inlines the field data (points3d.json, from bench/export_3d.py) into template.html and
writes a standalone page to webapp/product/index.html, which GitHub Pages serves at
https://mronchka.github.io/KeiserMagBridge/product/

    py product/build.py
"""
import io
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'webapp', 'product', 'index.html')

HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Upgrade your Keiser M3 with power and cadence detected wirelessly and broadcast over Bluetooth to Zwift.">
<meta name="theme-color" content="#0e0f16">
'''


def main():
    template = io.open(os.path.join(HERE, 'template.html'), encoding='utf-8').read()
    data = io.open(os.path.join(HERE, 'points3d.json'), encoding='utf-8').read().strip()
    assert '/*DATA*/' in template
    page = HEAD + template.replace('/*DATA*/', data) + '\n</html>\n'
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, 'w', encoding='utf-8', newline='\n').write(page)
    print('wrote', os.path.normpath(OUT), len(page), 'bytes')


if __name__ == '__main__':
    main()
