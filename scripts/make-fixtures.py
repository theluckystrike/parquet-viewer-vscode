#!/usr/bin/env python3
"""Writes the test and demo Parquet files with pyarrow, plus expected.json (values as pyarrow reads them).

Usage: python3 scripts/make-fixtures.py <fixtures dir> [--large <path> <MB>]
The large file goes outside the repo (for example ~/parquet-viewer-work/large.parquet) and is deleted after the test.
"""
import datetime as dt
import decimal
import json
import os
import random
import struct
import sys
import uuid

import pyarrow as pa
import pyarrow.parquet as pq

R = random.Random(42)


def trips(n):
    zones = ['Midtown', 'Upper East Side', 'JFK Airport', 'Williamsburg', 'Harlem', 'SoHo', 'Astoria', 'Park Slope', 'LaGuardia', 'Chelsea']
    pay = ['card', 'cash', 'app', 'voucher']
    t0 = dt.datetime(2026, 3, 1, 6, 0, 0)
    rows = {k: [] for k in ['trip_id', 'pickup_at', 'dropoff_at', 'passengers', 'distance_km', 'fare', 'payment', 'pickup_zone', 'tags', 'pickup', 'extras', 'driver_uid']}
    for i in range(n):
        start = t0 + dt.timedelta(seconds=i * 37 + R.randint(0, 30), microseconds=R.randint(0, 999999))
        dist = round(R.expovariate(1 / 4.2) + 0.3, 2)
        rows['trip_id'].append(9007199254740993 + i * 7)  # above 2^53: a JS number would round these
        rows['pickup_at'].append(start)
        rows['dropoff_at'].append(start + dt.timedelta(minutes=dist * 2.5 + R.randint(1, 9)))
        rows['passengers'].append(R.choice([1, 1, 1, 2, 2, 3, 4, None]))
        rows['distance_km'].append(dist)
        rows['fare'].append(decimal.Decimal(f'{3.5 + dist * 2.15 + R.randint(0, 300) / 100:.2f}'))
        rows['payment'].append(R.choice(pay))
        rows['pickup_zone'].append(R.choice(zones))
        rows['tags'].append(R.sample(['airport', 'night', 'shared', 'toll', 'rush', 'wheelchair'], R.randint(0, 3)) or None)
        rows['pickup'].append({'lat': round(40.70 + R.random() * 0.12, 5), 'lon': round(-74.02 + R.random() * 0.12, 5)})
        rows['extras'].append([('tip', round(R.random() * 8, 2)), ('toll', R.choice([0.0, 6.94]))])
        rows['driver_uid'].append(uuid.UUID(int=R.getrandbits(128)).bytes)
    schema = pa.schema([
        ('trip_id', pa.int64()), ('pickup_at', pa.timestamp('us')), ('dropoff_at', pa.timestamp('us')), ('passengers', pa.int8()),
        ('distance_km', pa.float64()), ('fare', pa.decimal128(10, 2)), ('payment', pa.dictionary(pa.int8(), pa.string())),
        ('pickup_zone', pa.string()), ('tags', pa.list_(pa.string())), ('pickup', pa.struct([('lat', pa.float64()), ('lon', pa.float64())])),
        ('extras', pa.map_(pa.string(), pa.float64())), ('driver_uid', pa.binary(16)),
    ])
    rows['payment'] = pa.array(rows['payment']).dictionary_encode().cast(pa.dictionary(pa.int8(), pa.string()))
    return pa.table(rows, schema=schema)


def precision():
    big = [2**53 + 1, -(2**63), 2**63 - 1, 0, None]
    return pa.table({
        'int64_big': pa.array(big, pa.int64()),
        'uint64_big': pa.array([2**64 - 1, 2**53 + 1, 0, 1, None], pa.uint64()),
        'dec38': pa.array([decimal.Decimal('1234567890123456789012345678.0123456789'), decimal.Decimal('-0.0000000001'), decimal.Decimal('0'), decimal.Decimal('99999999999999999999999999.9999999999'), None], pa.decimal128(38, 10)),
        'dec9_2': pa.array([decimal.Decimal('1234567.89'), decimal.Decimal('-0.05'), decimal.Decimal('0.10'), decimal.Decimal('10'), None], pa.decimal128(9, 2)),
        'dec18_4': pa.array([decimal.Decimal('12345678901234.5678'), decimal.Decimal('-1.0001'), decimal.Decimal('0'), decimal.Decimal('3.1416'), None], pa.decimal128(18, 4)),
        'ts_ns': pa.array([1700000000123456789, 0, -1, 1, None], pa.timestamp('ns')),
        'ts_us_utc': pa.array([dt.datetime(2026, 11, 8, 21, 0, 0, 123456, tzinfo=dt.timezone.utc), dt.datetime(1969, 12, 31, 23, 59, 59, tzinfo=dt.timezone.utc), None, dt.datetime(9999, 12, 31, 23, 59, 59, 999999, tzinfo=dt.timezone.utc), dt.datetime(1, 1, 1, tzinfo=dt.timezone.utc)], pa.timestamp('us', tz='UTC')),
        'date': pa.array([dt.date(2026, 11, 8), dt.date(1970, 1, 1), dt.date(1, 1, 1), dt.date(9999, 12, 31), None], pa.date32()),
        'time_us': pa.array([dt.time(23, 59, 59, 999999), dt.time(0, 0), dt.time(12, 30, 0, 500000), None, dt.time(1, 2, 3)], pa.time64('us')),
        'time_ms': pa.array([dt.time(23, 59, 59, 999000), dt.time(0, 0), None, dt.time(6, 7, 8, 9000), dt.time(1, 2, 3)], pa.time32('ms')),
        'flag': pa.array([True, False, None, True, False]),
        'raw': pa.array([b'\x00\x01\xff', b'', None, b'text', bytes(range(40))], pa.binary()),
        'note': pa.array(['plain', 'emoji \U0001F600 and 名前', '', None, 'line\nbreak, comma "quote"'], pa.large_string()),
        'f32': pa.array([1.1, -0.0, float('nan'), float('inf'), None], pa.float32()),
    })


def nested():
    return pa.table({
        'id': pa.array([1, 2, 3, 4]),
        'ints': pa.array([[1, 2, 3], [], None, [None, 5]], pa.list_(pa.int32())),
        'matrix': pa.array([[['a', 'b'], ['c']], [[]], None, [['d'], None]], pa.list_(pa.list_(pa.string()))),
        'person': pa.array([{'name': 'Ana', 'address': {'city': 'Lisbon', 'zip': '1000'}}, {'name': 'Bo', 'address': None}, None, {'name': None, 'address': {'city': 'Oslo', 'zip': None}}],
                           pa.struct([('name', pa.string()), ('address', pa.struct([('city', pa.string()), ('zip', pa.string())]))])),
        'scores': pa.array([[('math', 90), ('art', 75)], [], None, [('x', -1)]], pa.map_(pa.string(), pa.int64())),
        'events': pa.array([[{'t': 1, 'kind': 'open'}, {'t': 2, 'kind': 'close'}], [], None, [{'t': None, 'kind': 'x'}]], pa.list_(pa.struct([('t', pa.int64()), ('kind', pa.string())]))),
    })


def names():
    return pa.table({'rate %': [0.5, 1.25], 'a|b': ['x|y', 'z'], 'quote"col': ['"q"', "it's"], '名前': ['山田', 'Ünïcödé'], 'tab\tname': [1, 2]})


def norm(v):
    """pyarrow value -> the text this viewer shows (None stays None). Only flat values."""
    if v is None:
        return None
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return 'NaN'
        if v in (float('inf'), float('-inf')):
            return 'Infinity' if v > 0 else '-Infinity'
        r = repr(v)
        if r.endswith('.0'):
            r = r[:-2]
        return '0' if r == '-0' else r
    if isinstance(v, decimal.Decimal):
        return format(v, 'f')
    if isinstance(v, dt.datetime):
        s = v.replace(tzinfo=None).isoformat(sep=' ')
        if '.' in s:
            a, f = s.split('.')
            while len(f) > 3 and f.endswith('000'):
                f = f[:-3]
            s = a + '.' + f
        return s
    if isinstance(v, dt.date):
        return v.isoformat()
    if isinstance(v, dt.time):
        s = v.isoformat()
        if '.' in s:
            a, f = s.split('.')
            while len(f) > 3 and f.endswith('000'):
                f = f[:-3]
            s = a + '.' + f
        return s
    if isinstance(v, bytes):
        try:
            t = v.decode('utf-8')
            if not any(ord(c) < 9 or 13 < ord(c) < 32 for c in t):
                return t
        except UnicodeDecodeError:
            pass
        return '0x' + v[:64].hex() + (f'... ({len(v)} bytes)' if len(v) > 64 else '')
    if isinstance(v, str):
        return v
    return None  # nested: not compared here


def expected_for(path, n=5):
    t = pq.read_table(path)
    out = {'rows': t.num_rows, 'columns': t.column_names, 'first': []}
    for i in range(min(n, t.num_rows)):
        row = []
        for c in t.column_names:
            col = t.column(c)
            typ = col.type
            if pa.types.is_nested(typ) or pa.types.is_dictionary(typ) and False:
                row.append('__skip__')
                continue
            if pa.types.is_timestamp(typ) and typ.unit == 'ns':
                v = col[i].value  # integer ns
                if v is None:
                    row.append(None)
                    continue
                sec, frac = divmod(v, 10**9)
                base = (dt.datetime(1970, 1, 1) + dt.timedelta(seconds=sec)).isoformat(sep=' ')
                f = str(frac).rjust(9, '0')
                while len(f) > 3 and f.endswith('000'):
                    f = f[:-3]
                row.append(base + ('.' + f if frac else ''))
                continue
            if pa.types.is_fixed_size_binary(typ) and typ.byte_width == 16:
                v = col[i].as_py()
                row.append(None if v is None else '0x' + v.hex())
                continue
            row.append(norm(col[i].as_py()))
        out['first'].append(row)
    return out


def write_all(d):
    os.makedirs(d, exist_ok=True)
    exp = {}
    t = trips(50000)
    pq.write_table(t, f'{d}/taxi-trips.parquet', compression='zstd', row_group_size=10000)
    pq.write_table(precision(), f'{d}/precision.parquet', store_decimal_as_integer=True)
    pq.write_table(precision(), f'{d}/precision-flba.parquet')
    pq.write_table(nested(), f'{d}/nested.parquet')
    pq.write_table(names(), f"{d}/it's 100% names.parquet")
    small = t.slice(0, 2000)
    for codec in ['snappy', 'gzip', 'zstd', 'brotli', 'lz4', 'none']:
        pq.write_table(small, f'{d}/codec-{codec}.parquet', compression=codec)
    pq.write_table(small, f'{d}/legacy-v1.parq', version='1.0', data_page_version='1.0', use_dictionary=False, compression='snappy')
    pq.write_table(small, f'{d}/datapage-v2.pq', data_page_version='2.0', compression='zstd')
    pq.write_table(t.slice(0, 20000), f'{d}/page-index.parquet', write_page_index=True, data_page_size=4096, row_group_size=5000)
    pq.write_table(t.slice(0, 0), f'{d}/empty.parquet')
    for f in sorted(os.listdir(d)):
        if f.endswith(('.parquet', '.parq', '.pq')) and not f.startswith('hostile'):
            exp[f] = expected_for(f'{d}/{f}')
    # hostile files
    good = open(f'{d}/codec-snappy.parquet', 'rb').read()
    open(f'{d}/hostile-truncated.parquet', 'wb').write(good[: len(good) // 2])
    open(f'{d}/hostile-not-parquet.parquet', 'wb').write(b'trip_id,fare\n1,2.50\n2,3.75\n')
    open(f'{d}/hostile-zero-bytes.parquet', 'wb').write(b'')
    bad = bytearray(good)
    struct.pack_into('<I', bad, len(bad) - 8, len(bad) * 3)
    open(f'{d}/hostile-footer-past-eof.parquet', 'wb').write(bytes(bad))
    open(f'{d}/hostile-chunk-4gb.parquet', 'wb').write(chunk_claims_4gb(f'{d}/codec-none.parquet'))
    open(f'{d}/hostile-garbage-footer.parquet', 'wb').write(garbage_footer(good))
    json.dump(exp, open(f'{d}/expected.json', 'w'), indent=1, ensure_ascii=False)


def zz(n):
    return (n << 1) ^ (n >> 63)


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def chunk_claims_4gb(path):
    """Rewrites total_compressed_size of the first column chunk to 4 GiB (thrift compact varint, footer length fixed up)."""
    data = open(path, 'rb').read()
    md = pq.ParquetFile(path).metadata
    cc = md.row_group(0).column(0)
    flen = struct.unpack_from('<I', data, len(data) - 8)[0]
    fstart = len(data) - 8 - flen
    footer = data[fstart: len(data) - 8]
    pat = b'\x16' + varint(zz(cc.total_uncompressed_size)) + b'\x16' + varint(zz(cc.total_compressed_size))
    i = footer.find(pat)
    if i < 0:
        raise SystemExit('pattern not found for the 4 GB chunk fixture')
    rep = b'\x16' + varint(zz(cc.total_uncompressed_size)) + b'\x16' + varint(zz(4 * 1024**3))
    nf = footer[:i] + rep + footer[i + len(pat):]
    return data[:fstart] + nf + struct.pack('<I', len(nf)) + b'PAR1'


def garbage_footer(good):
    flen = struct.unpack_from('<I', good, len(good) - 8)[0]
    fstart = len(good) - 8 - flen
    junk = bytes(R.getrandbits(8) for _ in range(flen))
    return good[:fstart] + junk + good[-8:]


def write_large(path, mb):
    """About mb megabytes of mostly incompressible rows, written in batches (memory stays small)."""
    import numpy as np
    rng = np.random.default_rng(7)
    schema = pa.schema([('id', pa.int64()), ('ts', pa.timestamp('us')), ('sensor', pa.string()), ('value', pa.float64()), ('payload', pa.string())])
    w = pq.ParquetWriter(path, schema, compression='snappy')
    rows_per = 500000
    i = 0
    sensors = np.array([f'sensor-{k:03d}' for k in range(500)])
    while os.path.getsize(path) < mb * 1024 * 1024 if os.path.exists(path) else True:
        ids = np.arange(i, i + rows_per, dtype=np.int64)
        ts = (np.int64(1767225600000000) + ids * 1000003).astype('datetime64[us]')
        sensor = sensors[rng.integers(0, 500, rows_per)]
        value = rng.normal(20, 5, rows_per)
        raw = rng.integers(0, 2**63, (rows_per, 3), dtype=np.int64)
        payload = np.char.mod('%016x', raw[:, 0]).astype(object) + np.char.mod('%016x', raw[:, 1]).astype(object) + np.char.mod('%016x', raw[:, 2]).astype(object)
        w.write_table(pa.table({'id': ids, 'ts': ts, 'sensor': sensor, 'value': value, 'payload': payload}, schema=schema), row_group_size=1024 * 1024)
        i += rows_per
        if i > 200_000_000:
            break
    w.close()
    print(path, os.path.getsize(path), 'bytes', i, 'rows')


if __name__ == '__main__':
    if len(sys.argv) >= 4 and sys.argv[1] == '--large':
        write_large(sys.argv[2], int(sys.argv[3]))
    else:
        write_all(sys.argv[1])
        print('fixtures written to', sys.argv[1])
