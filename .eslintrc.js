module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js'],
  overrides: [
    {
      // ADR-0003 decision 11: tasks, projects and custom fields are written
      // ONLY by their own services (which carry validation + the activity
      // row) or through DomainWriter. Everything else depends on DomainWriter.
      // Reads (find*, count, aggregate) are unrestricted. Specs and test/
      // fixtures are exempt: they seed data directly on purpose.
      files: ['src/**/*.ts'],
      excludedFiles: [
        'src/projects-tasks/**',
        'src/domain-writer/**',
        'src/**/*.spec.ts',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector:
              "CallExpression[callee.property.name=/^(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)$/][callee.object.property.name=/^(task|project|customField)$/]",
            message:
              'Write tasks/projects/custom fields through DomainWriter (src/domain-writer), not Prisma directly. See ADR-0003.',
          },
        ],
      },
    },
  ],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    // `_name` = parameter required by an interface/override but unused here.
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
