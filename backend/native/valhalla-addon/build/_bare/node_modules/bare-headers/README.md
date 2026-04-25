# bare-headers

Development headers for Bare.

## Building

To generate the `include/` directory prior to publishing the headers, do:

```console
gh workflow run generate
gh run watch
gh run download --name include --dir include
```

## License

Apache-2.0
