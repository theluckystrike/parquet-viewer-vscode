# Changelog

## 0.1.0

- First release: Parquet files open as a grid with virtual scrolling. Only the footer and the rows on screen are read.
- Exact DECIMAL, INT64, UINT64 and nanosecond timestamps; INT96, DATE, TIME, UUID, FLOAT16, JSON and INTERVAL values; nested LIST, MAP and STRUCT with a tree view.
- Snappy, Gzip, Zstd, Brotli, LZ4 and LZ4_RAW; data pages v1 and v2.
- Filter, sort and search over the whole file in a background thread, with progress and Cancel.
- Copy as CSV, JSON, Markdown or tab-separated text; export to CSV or JSON Lines.
- Schema tab with row groups, compression, page index, key-value metadata and Copy schema as JSON.
- Clear messages for empty, cut-off, damaged, encrypted and non-Parquet files.
