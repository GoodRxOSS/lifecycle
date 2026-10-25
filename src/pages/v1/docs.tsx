import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: { destination: '/v2/docs', permanent: false },
});

export default function RetiredApiDocs() {
  return null;
}
